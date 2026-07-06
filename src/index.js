import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { sendFailureAlert } from './utils/alerts.js';
import { runTagSync } from './sync/tagSync.js';
import { runFilterSync } from './sync/filterSync.js';

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

    const secs = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(
      `[runAll] finished in ${secs}s — tag=${JSON.stringify(tagStats)} filter=${JSON.stringify(filterStats)}`,
    );

    // Alert on ANY sync failure, not just when both fail. A single-sync outage
    // (e.g. filter-sync dies but tag-sync succeeds) still needs eyes on it.
    const failed = [];
    if (tagStats?.error) failed.push({ sync: 'tag', error: tagStats.error });
    if (filterStats?.error) failed.push({ sync: 'filter', error: filterStats.error });
    if (failed.length > 0) {
      const summary = failed.map((f) => `${f.sync}=${f.error.message}`).join('; ');
      const alertErr = new Error(
        failed.length === 2 ? `Both syncs failed: ${summary}` : `${failed[0].sync}-sync failed: ${summary}`,
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

function start() {
  logger.info(
    `[index] scheduling sync with cron "${config.schedule.cron}" (${config.schedule.timezone})`,
  );
  cron.schedule(config.schedule.cron, () => runAll('cron'), {
    timezone: config.schedule.timezone,
  });

  if (process.env.RUN_ON_START === 'true') {
    logger.info('[index] RUN_ON_START=true — kicking off initial run');
    runAll('startup');
  }

  logger.info('[index] scheduler running. Press Ctrl+C to exit.');
}

start();
