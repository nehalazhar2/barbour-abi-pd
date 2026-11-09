import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { sendFailureAlert } from './utils/alerts.js';
import { runTagSync } from './sync/tagSync.js';
import { runFilterSync } from './sync/filterSync.js';
import { runRefreshSync } from './sync/refreshSync.js';
import { runBackfillReprocess, parkForever, parseWindow, checkBackfillWindow } from './sync/backfillReprocess.js';
import { runLock } from './utils/runLock.js';
import { resetSavedSearchCache } from './barbourabi/savedSearches.js';
import { resetTagCache } from './barbourabi/tags.js';
import { resetClassificationRun } from './sync/leadClassification.js';
import { runCatchupSync } from './sync/catchupSync.js';
import { runRollupSync } from './sync/rollupSync.js';
import { sendBackfillEmail } from './utils/alerts.js';

// One lock for every pass: the daily run, the weekly catch-up and the A4
// overnight re-process must never overlap (all write the same leads). A skipped
// run alerts — a silent skip would look exactly like a quiet day.

async function alertSkipped(what, trigger) {
  logger.warn(`[${what}] another run (${runLock.holder()}) still in progress — skipping (trigger=${trigger})`);
  await sendFailureAlert(new Error(`${what} skipped: another sync run was still in progress`), { trigger, reason: 'lock held' });
}

async function runAll(trigger = 'cron') {
  if (!runLock.tryAcquire('daily')) {
    await alertSkipped('runAll', trigger);
    return;
  }
  const start = Date.now();
  logger.info(`[runAll] starting sync run (trigger=${trigger})`);
  // The worker lives for weeks between deploys. Without these, a saved search
  // edited or deleted in Barbour keeps running as it was at the last deploy.
  resetSavedSearchCache();
  resetTagCache();
  resetClassificationRun();

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
    // Phase 2 / A1 — after refresh so it sees this morning's lead changes. Off
    // (returns { skipped }) unless the roll-up fields are configured.
    const rollupStats = await runRollupSync().catch((err) => {
      logger.error(`[runAll] rollupSync threw: ${err.message}`);
      return { error: err };
    });

    const secs = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(
      `[runAll] finished in ${secs}s — tag=${JSON.stringify(tagStats)} filter=${JSON.stringify(filterStats)} refresh=${JSON.stringify(refreshStats)} rollup=${JSON.stringify(rollupStats)}`,
    );

    // Alert on ANY sync failure, not just when all fail. A single-sync outage
    // (e.g. refresh-sync dies but tag+filter succeed) still needs eyes on it.
    const failed = [];
    if (tagStats?.error) failed.push({ sync: 'tag', error: tagStats.error });
    if (filterStats?.error) failed.push({ sync: 'filter', error: filterStats.error });
    if (refreshStats?.error) failed.push({ sync: 'refresh', error: refreshStats.error });
    if (rollupStats?.error) failed.push({ sync: 'rollup', error: rollupStats.error });
    // Per-org write failures are caught inside the roll-up and only counted —
    // without this a systematic 400 (e.g. a field shape change) would be silent.
    else if (rollupStats?.failed > 0) {
      failed.push({ sync: 'rollup', error: new Error(`${rollupStats.failed} org roll-up write(s) failed (${rollupStats.written ?? 0} written) — see logs`) });
    }
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
    runLock.release('daily');
  }
}

// Weekly saved-search catch-up — see src/sync/catchupSync.js.
async function runCatchup(trigger = 'cron') {
  if (!runLock.tryAcquire('catchup')) {
    await alertSkipped('catchupSync', trigger);
    return;
  }
  try {
    await runCatchupSync();
  } catch (err) {
    logger.error(`[catchupSync] run failed: ${err.message}`);
    await sendFailureAlert(err, { trigger, sync: 'catchup' });
    // The catch-up's own recipients should hear about a failed week too, not
    // only ALERT_EMAIL. (No-op under DRY_RUN.)
    await sendBackfillEmail({
      to: config.catchup.alertEmails,
      subject: 'Barbour weekly catch-up: FAILED — nothing imported',
      text: `The weekly catch-up stopped before importing anything:\n\n${err.message}\n\nIt will try again next week. Check DO Runtime Logs for detail.`,
    });
  } finally {
    runLock.release('catchup');
  }
}

function scheduleCron() {
  logger.info(
    `[index] scheduling sync with cron "${config.schedule.cron}" (${config.schedule.timezone})`,
  );
  cron.schedule(config.schedule.cron, () => runAll('cron'), {
    timezone: config.schedule.timezone,
  });
  if (!config.catchup.enabled) {
    logger.info('[index] weekly catch-up disabled (CATCHUP_ENABLED is not "true")');
  } else if (!cron.validate(config.catchup.cron)) {
    // Don't throw: a boot failure makes DO roll back the whole deploy.
    logger.error(`[index] CATCHUP_CRON "${config.catchup.cron}" is not a valid cron expression — weekly catch-up NOT scheduled`);
  } else {
    logger.info(`[index] scheduling weekly catch-up with cron "${config.catchup.cron}" (${config.schedule.timezone}); hold above ${config.catchup.maxCreates}`);
    cron.schedule(config.catchup.cron, () => runCatchup('cron'), { timezone: config.schedule.timezone });
  }
  logger.info('[index] scheduler running. Press Ctrl+C to exit.');
}

function start() {
  // One-off re-process mode — runs the backfill FIRST, with the cron NOT yet
  // scheduled (the backfill spans hours and would collide with the 07:00
  // window). When it completes we schedule the cron in this same process so the
  // next 07:00 run isn't missed. Unset BACKFILL_MODE on DO afterwards so a
  // container restart doesn't start the backfill again from scratch.
  if (config.backfill.mode === 'reprocess' && config.backfill.window) {
    // Phase 2 / A4 — multi-night re-process inside BACKFILL_WINDOW. The cron is
    // scheduled FIRST so the daily run never misses a morning; the backfill
    // shares its lock and pauses outside the window.
    scheduleCron();
    let window;
    try {
      window = parseWindow(config.backfill.window);
      checkBackfillWindow({
        window,
        phases: config.backfill.phases,
        crons: [config.schedule.cron, ...(config.catchup.enabled ? [config.catchup.cron] : [])],
      });
    } catch (err) {
      // Config error: don't start the backfill, keep the normal cron running.
      logger.error(`[index] backfill NOT started — ${err.message}`);
      sendFailureAlert(err, { trigger: 'backfill' });
      return;
    }
    logger.info(`[index] BACKFILL_MODE=reprocess — running inside window ${window.label} London; daily cron already scheduled`);
    runBackfillReprocess({ window, lock: runLock }).catch(async (err) => {
      logger.error(`[index] backfill threw: ${err.message}`);
      await sendFailureAlert(err, { trigger: 'backfill' });
    });
    return;
  }

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

  // Startup runs go one after the other, never in parallel (shared lock).
  const runDaily = process.env.RUN_ON_START === 'true';
  // A leftover CATCHUP_RUN_ON_START must not run a catch-up that's switched off.
  const runWeekly = config.catchup.runOnStart && config.catchup.enabled;
  if (config.catchup.runOnStart && !config.catchup.enabled) {
    logger.warn('[index] CATCHUP_RUN_ON_START=true ignored — CATCHUP_ENABLED is not "true"');
  }
  if (runDaily || runWeekly) {
    (async () => {
      if (runDaily) {
        logger.info('[index] RUN_ON_START=true — kicking off initial run');
        await runAll('startup');
      }
      if (runWeekly) {
        logger.info('[index] CATCHUP_RUN_ON_START=true — running the weekly catch-up now. Unset it afterwards.');
        await runCatchup('startup');
      }
    })();
  }
}

start();
