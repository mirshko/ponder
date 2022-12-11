import EventEmitter from "node:events";
import { watch } from "node:fs";
import path from "node:path";

import { PonderCliOptions } from "@/bin/ponder";
import { generateContractTypes } from "@/codegen/generateContractTypes";
import { generateHandlerTypes } from "@/codegen/generateHandlerTypes";
import { logger, PonderLogger } from "@/common/logger";
import { buildOptions, PonderOptions } from "@/common/options";
import { PonderConfig, readPonderConfig } from "@/common/readPonderConfig";
import { endBenchmark, startBenchmark } from "@/common/utils";
import { isFileChanged } from "@/common/utils";
import { buildCacheStore, CacheStore } from "@/db/cache/cacheStore";
import { buildDb, PonderDatabase } from "@/db/db";
import { buildEntityStore, EntityStore } from "@/db/entity/entityStore";
import { createHandlerQueue, HandlerQueue } from "@/handlers/handlerQueue";
import { readHandlers } from "@/handlers/readHandlers";
import { getLogs } from "@/indexer/tasks/getLogs";
import { startBackfill } from "@/indexer/tasks/startBackfill";
import { startFrontfill } from "@/indexer/tasks/startFrontfill";
import type { Network } from "@/networks/base";
import { buildNetworks } from "@/networks/buildNetworks";
import type { ResolvedPonderPlugin } from "@/plugin";
import { buildPonderSchema } from "@/schema/buildPonderSchema";
import { readSchema } from "@/schema/readSchema";
import type { PonderSchema } from "@/schema/types";
import { buildSources } from "@/sources/buildSources";
import type { EvmSource } from "@/sources/evm";
import { getUiState, HandlersStatus, render, UiState } from "@/ui/app";

export class Ponder extends EventEmitter {
  config: PonderConfig;

  sources: EvmSource[];
  networks: Network[];

  database: PonderDatabase;
  cacheStore: CacheStore;
  entityStore: EntityStore;

  schema: PonderSchema;
  handlerQueue?: HandlerQueue;
  logsProcessedToTimestamp: number;
  isHandlingLogs: boolean;

  // Hot reloading
  watchFiles: string[];
  killFrontfillQueues?: () => void;
  killBackfillQueues?: () => void;
  killWatchers?: () => void;

  // Plugins
  plugins: ResolvedPonderPlugin[];
  logger: PonderLogger;
  options: PonderOptions;

  // Interface
  renderInterval?: NodeJS.Timer;
  ui: UiState;

  constructor(cliOptions: PonderCliOptions) {
    super();

    this.on("newNetworkConnected", this.handleNewNetworkConnected);
    this.on("newBackfillLogs", this.handleNewBackfillLogs);
    this.on("newFrontfillLogs", this.handleNewFrontfillLogs);

    this.on("backfillTasksAdded", this.handleBackfillTasksAdded);
    this.on("backfillTaskCompleted", this.handleBackfillTaskCompleted);

    this.on("handlerTaskStarted", this.handleHandlerTaskStarted);

    this.on("configError", this.handleConfigError);
    this.on("handlerTaskError", this.handleHandlerTaskError);

    this.options = buildOptions(cliOptions);

    this.logsProcessedToTimestamp = 0;
    this.isHandlingLogs = false;
    this.ui = getUiState(this.options);

    this.config = readPonderConfig(this.options.PONDER_CONFIG_FILE_PATH);

    this.database = buildDb({ ponder: this });
    this.cacheStore = buildCacheStore(this.database);
    this.entityStore = buildEntityStore(this.database);

    this.logger = logger;

    const { networks } = buildNetworks({ ponder: this });
    this.networks = networks;

    const { sources } = buildSources({ ponder: this });
    this.sources = sources;

    const userSchema = readSchema({ ponder: this });
    this.schema = buildPonderSchema(userSchema);

    this.plugins = this.config.plugins || [];
    this.watchFiles = [
      this.options.SCHEMA_FILE_PATH,
      this.options.HANDLERS_DIR_PATH,
      ...sources
        .map((s) => s.abiFilePath)
        .filter((p): p is string => typeof p === "string"),
    ];
  }

  async setup() {
    this.renderInterval = setInterval(() => {
      this.ui.timestamp = Math.floor(Date.now() / 1000);
      render(this.ui);
    }, 1000);

    await Promise.all([
      this.cacheStore.migrate(),
      this.entityStore.migrate(this.schema),
      this.reloadHandlers(),
    ]);

    // If there is a config error, display the error and exit the process.
    // Eventually, it might make sense to support hot reloading for ponder.config.js.
    if (this.ui.configError) {
      process.exit(1);
    }
  }

  kill() {
    clearInterval(this.renderInterval);
    this.handlerQueue?.kill();
    this.killFrontfillQueues?.();
    this.killBackfillQueues?.();
    this.killWatchers?.();
    this.teardownPlugins();
  }

  async start() {
    this.ui.isProd = true;
    await this.setup();

    this.codegen();
    this.setupPlugins();

    await this.backfill();
    this.handleNewLogs();
  }

  async dev() {
    await this.setup();
    this.watch();

    this.codegen();
    this.setupPlugins();

    this.backfill();
    this.handleNewLogs();
  }

  codegen() {
    generateContractTypes({ ponder: this });
    generateHandlerTypes({ ponder: this });
  }

  async reloadSchema() {
    const userSchema = readSchema({ ponder: this });
    this.schema = buildPonderSchema(userSchema);
    await this.entityStore.migrate(this.schema);
  }

  async reloadHandlers() {
    if (this.handlerQueue) {
      logger.debug("Killing old handlerQueue");
      this.handlerQueue.kill();
      this.isHandlingLogs = false;
    }

    const handlers = await readHandlers({ ponder: this });

    this.handlerQueue = createHandlerQueue({
      ponder: this,
      handlers: handlers,
    });
  }

  async reload() {
    await Promise.all([this.reloadSchema(), this.reloadHandlers()]);

    this.codegen();
    this.reloadPlugins();

    this.logsProcessedToTimestamp = 0;
    this.ui.handlersTotal = 0;
    this.ui.handlersCurrent = 0;
    this.ui.handlerError = null;

    this.handleNewLogs();
  }

  async backfill() {
    this.ui = {
      ...this.ui,
      backfillStartTimestamp: Math.floor(Date.now() / 1000),
    };
    render(this.ui);

    const startHrt = startBenchmark();

    const { blockNumberByNetwork, killFrontfillQueues } = await startFrontfill({
      ponder: this,
    });
    this.killFrontfillQueues = killFrontfillQueues;

    const { killBackfillQueues, drainBackfillQueues } = await startBackfill({
      ponder: this,
      blockNumberByNetwork,
    });
    this.killBackfillQueues = killBackfillQueues;

    await drainBackfillQueues();
    const duration = endBenchmark(startHrt);

    logger.debug(`Backfill completed in ${duration}`);

    this.ui = {
      ...this.ui,
      isBackfillComplete: true,
      backfillDuration: duration,
    };
    render(this.ui);

    // If there were no backfill logs, handleNewLogs won't get triggered until the next
    // set of frontfill logs. So, trigger it manually here.
    this.handleNewLogs();
  }

  async handleNewLogs() {
    if (!this.handlerQueue) {
      console.error(
        `Attempted to handle new block, but handler queue doesnt exist`
      );
      return;
    }

    if (this.isHandlingLogs) return;
    this.isHandlingLogs = true;

    const { hasNewLogs, toTimestamp, logs } = await getLogs({
      ponder: this,
      fromTimestamp: this.logsProcessedToTimestamp,
    });

    if (!hasNewLogs) {
      this.isHandlingLogs = false;
      return;
    }

    this.ui.handlersTotal += logs.length;
    render(this.ui);

    logger.debug(`Adding ${logs.length} to handlerQueue`);

    for (const log of logs) {
      this.handlerQueue.push({ log });
    }

    this.logsProcessedToTimestamp = toTimestamp;
    this.isHandlingLogs = false;
  }

  private handleBackfillTasksAdded(taskCount: number) {
    this.ui.backfillTaskTotal += taskCount;
    this.updateBackfillEta();
    render(this.ui);
  }

  private handleBackfillTaskCompleted() {
    this.ui.backfillTaskCurrent += 1;
    this.updateBackfillEta();
    render(this.ui);
  }

  private updateBackfillEta() {
    const newEta = Math.round(
      ((Math.floor(Date.now() / 1000) - this.ui.backfillStartTimestamp) /
        this.ui.backfillTaskCurrent) *
        this.ui.backfillTaskTotal
    );
    if (!Number.isFinite(newEta)) return;

    this.ui.backfillEta =
      newEta - (this.ui.timestamp - this.ui.backfillStartTimestamp);
  }

  private handleHandlerTaskStarted() {
    this.ui.handlersCurrent += 1;
    this.ui.handlersStatus =
      this.ui.handlersCurrent === this.ui.handlersTotal
        ? HandlersStatus.UP_TO_DATE
        : HandlersStatus.IN_PROGRESS;
    render(this.ui);
  }

  private handleConfigError(error: string) {
    this.ui = {
      ...this.ui,
      configError: error,
    };
    render(this.ui);
  }

  private handleHandlerTaskError(error: string) {
    this.ui = {
      ...this.ui,
      handlerError: error,
    };
    render(this.ui);
  }

  private handleNewNetworkConnected({
    network,
    blockNumber,
    blockTimestamp,
  }: {
    network: string;
    blockNumber: number;
    blockTimestamp: number;
  }) {
    this.ui.networks[network] = {
      name: network,
      blockNumber: blockNumber,
      blockTimestamp: blockTimestamp,
      blockTxnCount: -1,
      matchedLogCount: -1,
    };
  }

  private handleNewFrontfillLogs({
    network,
    blockNumber,
    blockTimestamp,
    blockTxnCount,
    matchedLogCount,
  }: {
    network: string;
    blockNumber: number;
    blockTimestamp: number;
    blockTxnCount: number;
    matchedLogCount: number;
  }) {
    this.handleNewLogs();
    this.ui.networks[network] = {
      name: network,
      blockNumber: blockNumber,
      blockTimestamp: blockTimestamp,
      blockTxnCount: blockTxnCount,
      matchedLogCount: matchedLogCount,
    };
    render(this.ui);
  }

  private handleNewBackfillLogs() {
    this.handleNewLogs();
  }

  watch() {
    const watchers = this.watchFiles.map((fileOrDirName) =>
      watch(fileOrDirName, { recursive: true }, (_, fileName) => {
        const fullPath =
          path.basename(fileOrDirName) === fileName
            ? fileOrDirName
            : path.join(fileOrDirName, fileName);

        logger.debug("File changed:");
        logger.debug({ fileOrDirName, fileName, fullPath });

        if (isFileChanged(fullPath)) {
          logger.info("");
          logger.info(`\x1b[35m${`Detected change in: ${fileName}`}\x1b[0m`); // yellow
          logger.info("");

          this.reload();
        } else {
          logger.debug("File content not changed, not reloading");
        }
      })
    );

    this.killWatchers = () => {
      watchers.forEach((w) => w.close());
    };
  }

  async setupPlugins() {
    for (const plugin of this.plugins) {
      if (!plugin.setup) return;
      await plugin.setup(this);
    }
  }

  async reloadPlugins() {
    for (const plugin of this.plugins) {
      if (!plugin.reload) return;
      await plugin.reload(this);
    }
  }

  async teardownPlugins() {
    for (const plugin of this.plugins) {
      if (!plugin.teardown) return;
      plugin.teardown(this);
    }
  }
}