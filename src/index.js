import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { sendFailureAlert } from './utils/alerts.js';
import { runTagSync } from './sync/tagSync.js';
import { runFilterSync } from './sync/filterSync.js';
import { runRefreshSync } from './sync/refreshSync.js';
import { runBackfillReprocess, parkForever } from './sync/backfillReprocess.js';

let running = false;

async function runAll(trigger = 'cron') {
  if (running) {
    logger.warn(`[runAll] previous run still in progress — skipping (trigger=${trigger})`);
    return;
  }
  running = true;
  const start = Date.now();
  logger.info(`[runAll] starting sync run (trigger=${trigger})`);

  try {
    const tagStats = await runTagSync().catch((err) => {
      logger.error(`[runAll] tagSync threw: ${err.message}`);
      return { error: err };
    });
    const filterStats = await runFilterSync().catch((err) => {
      logger.error(`[runAll] filterSync threw: ${err.message}`);
      return { error: err };
    });
    // Refresh runs LAST — tag sync may have just moved projects onto the CRM
    // tag, and we don't want to immediately re-process them via refresh in the
    // same run. Running last means the earliest a tagged-and-swapped project
    // gets refreshed is tomorrow's run, which is the intended semantics.
    const refreshStats = await runRefreshSync().catch((err) => {
      logger.error(`[runAll] refreshSync threw: ${err.message}`);
      return { error: err };
    });

    const secs = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(
      `[runAll] finished in ${secs}s — tag=${JSON.stringify(tagStats)} filter=${JSON.stringify(filterStats)} refresh=${JSON.stringify(refreshStats)}`,
    );

    // Alert on ANY sync failure, not just when all fail. A single-sync outage
    // (e.g. refresh-sync dies but tag+filter succeed) still needs eyes on it.
    const failed = [];
    if (tagStats?.error) failed.push({ sync: 'tag', error: tagStats.error });
    if (filterStats?.error) failed.push({ sync: 'filter', error: filterStats.error });
    if (refreshStats?.error) failed.push({ sync: 'refresh', error: refreshStats.error });
    if (failed.length > 0) {
      const summary = failed.map((f) => `${f.sync}=${f.error.message}`).join('; ');
      const alertErr = new Error(
        failed.length > 1 ? `Multiple syncs failed: ${summary}` : `${failed[0].sync}-sync failed: ${summary}`,
      );
      await sendFailureAlert(alertErr, { trigger, failed: failed.map((f) => f.sync) });
    }
  } catch (err) {
    logger.error(`[runAll] run failed: ${err.message}`);
    await sendFailureAlert(err, { trigger });
  } finally {
    running = false;
  }
}

function scheduleCron() {
  logger.info(
    `[index] scheduling sync with cron "${config.schedule.cron}" (${config.schedule.timezone})`,
  );
  cron.schedule(config.schedule.cron, () => runAll('cron'), {
    timezone: config.schedule.timezone,
  });
  logger.info('[index] scheduler running. Press Ctrl+C to exit.');
}

function start() {
  // One-off re-process mode — runs the backfill FIRST, with the cron NOT yet
  // scheduled (the backfill spans hours and would collide with the 07:00
  // window). When it completes we schedule the cron in this same process so the
  // next 07:00 run isn't missed. Unset BACKFILL_MODE on DO afterwards so a
  // container restart doesn't start the backfill again from scratch.
  if (config.backfill.mode === 'reprocess') {
    logger.info('[index] BACKFILL_MODE=reprocess — running one-off re-process first (cron scheduled on completion)');
    runBackfillReprocess()
      .then(() => scheduleCron())
      .catch(async (err) => {
        logger.error(`[index] backfill threw: ${err.message}`);
        await sendFailureAlert(err, { trigger: 'backfill' });
        // Don't exit — DO would restart-loop us. Park (with a live handle, so the
        // event loop can't drain) until a redeploy after fixing the issue.
        await parkForever();
      });
    return;
  }

  scheduleCron();

  if (process.env.RUN_ON_START === 'true') {
    logger.info('[index] RUN_ON_START=true — kicking off initial run');
    runAll('startup');
  }
}

start();
