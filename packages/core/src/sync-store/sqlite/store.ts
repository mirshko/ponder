import type Sqlite from "better-sqlite3";
import {
  type ExpressionBuilder,
  Kysely,
  Migrator,
  sql,
  SqliteDialect,
  type Transaction as KyselyTransaction,
} from "kysely";
import type { Hex, RpcBlock, RpcLog, RpcTransaction } from "viem";

import type { FactoryCriteria, LogFilterCriteria } from "@/config/sources.js";
import type { Block } from "@/types/block.js";
import type { Log } from "@/types/log.js";
import type { Transaction } from "@/types/transaction.js";
import type { NonNull } from "@/types/utils.js";
import { decodeToBigInt, encodeAsText } from "@/utils/encoding.js";
import {
  buildFactoryFragments,
  buildLogFilterFragments,
} from "@/utils/fragments.js";
import { intervalIntersectionMany, intervalUnion } from "@/utils/interval.js";
import { range } from "@/utils/range.js";

import type { SyncStore } from "../store.js";
import type { BigIntText } from "./format.js";
import {
  rpcToSqliteBlock,
  rpcToSqliteLog,
  rpcToSqliteTransaction,
  type SyncStoreTables,
} from "./format.js";
import { migrationProvider } from "./migrations.js";

export class SqliteSyncStore implements SyncStore {
  kind = "sqlite" as const;
  db: Kysely<SyncStoreTables>;
  migrator: Migrator;

  constructor({ db }: { db: Sqlite.Database }) {
    this.db = new Kysely<SyncStoreTables>({
      dialect: new SqliteDialect({ database: db }),
    });

    this.migrator = new Migrator({
      db: this.db,
      provider: migrationProvider,
    });
  }

  migrateUp = async () => {
    const { error } = await this.migrator.migrateToLatest();
    if (error) throw error;
  };

  async kill() {
    await this.db.destroy();
  }

  insertLogFilterInterval = async ({
    chainId,
    logFilter,
    block: rpcBlock,
    transactions: rpcTransactions,
    logs: rpcLogs,
    interval,
  }: {
    chainId: number;
    logFilter: LogFilterCriteria;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("blocks")
        .values({ ...rpcToSqliteBlock(rpcBlock), chainId })
        .onConflict((oc) => oc.column("hash").doNothing())
        .execute();

      for (const rpcTransaction of rpcTransactions) {
        await tx
          .insertInto("transactions")
          .values({ ...rpcToSqliteTransaction(rpcTransaction), chainId })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();
      }

      for (const rpcLog of rpcLogs) {
        await tx
          .insertInto("logs")
          .values({ ...rpcToSqliteLog(rpcLog), chainId })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
      }

      await this._insertLogFilterInterval({
        tx,
        chainId,
        logFilters: [logFilter],
        interval,
      });
    });
  };

  getLogFilterIntervals = async ({
    chainId,
    logFilter,
  }: {
    chainId: number;
    logFilter: LogFilterCriteria;
  }) => {
    const fragments = buildLogFilterFragments({ ...logFilter, chainId });

    // First, attempt to merge overlapping and adjacent intervals.
    await Promise.all(
      fragments.map(async (fragment) => {
        return await this.db.transaction().execute(async (tx) => {
          const { id: logFilterId } = await tx
            .insertInto("logFilters")
            .values(fragment)
            .onConflict((oc) => oc.doUpdateSet(fragment))
            .returningAll()
            .executeTakeFirstOrThrow();

          const existingIntervalRows = await tx
            .deleteFrom("logFilterIntervals")
            .where("logFilterId", "=", logFilterId)
            .returningAll()
            .execute();

          const mergedIntervals = intervalUnion(
            existingIntervalRows.map((i) => [
              Number(decodeToBigInt(i.startBlock)),
              Number(decodeToBigInt(i.endBlock)),
            ]),
          );

          const mergedIntervalRows = mergedIntervals.map(
            ([startBlock, endBlock]) => ({
              logFilterId,
              startBlock: encodeAsText(startBlock),
              endBlock: encodeAsText(endBlock),
            }),
          );

          if (mergedIntervalRows.length > 0) {
            await tx
              .insertInto("logFilterIntervals")
              .values(mergedIntervalRows)
              .execute();
          }

          return mergedIntervals;
        });
      }),
    );

    const intervals = await this.db
      .with(
        "logFilterFragments(fragmentId, fragmentAddress, fragmentTopic0, fragmentTopic1, fragmentTopic2, fragmentTopic3)",
        () =>
          sql`( values ${sql.join(
            fragments.map(
              (f) =>
                sql`( ${sql.val(f.id)}, ${sql.val(f.address)}, ${sql.val(
                  f.topic0,
                )}, ${sql.val(f.topic1)}, ${sql.val(f.topic2)}, ${sql.val(
                  f.topic3,
                )} )`,
            ),
          )} )`,
      )
      .selectFrom("logFilterIntervals")
      .leftJoin("logFilters", "logFilterId", "logFilters.id")
      .innerJoin("logFilterFragments", (join) => {
        let baseJoin = join.on(({ or, cmpr }) =>
          or([
            cmpr("address", "is", null),
            cmpr("fragmentAddress", "=", sql.ref("address")),
          ]),
        );
        for (const idx_ of range(0, 4)) {
          baseJoin = baseJoin.on(({ or, cmpr }) => {
            const idx = idx_ as 0 | 1 | 2 | 3;
            return or([
              cmpr(`topic${idx}`, "is", null),
              cmpr(`fragmentTopic${idx}`, "=", sql.ref(`topic${idx}`)),
            ]);
          });
        }

        return baseJoin;
      })
      .select(["fragmentId", "startBlock", "endBlock"])
      .where("chainId", "=", chainId)
      .execute();

    const intervalsByFragment = intervals.reduce(
      (acc, cur) => {
        const { fragmentId, ...rest } = cur;
        acc[fragmentId] ||= [];
        acc[fragmentId].push({
          startBlock: decodeToBigInt(rest.startBlock),
          endBlock: decodeToBigInt(rest.endBlock),
        });
        return acc;
      },
      {} as Record<string, { startBlock: bigint; endBlock: bigint }[]>,
    );

    const fragmentIntervals = fragments.map((f) => {
      return (intervalsByFragment[f.id] ?? []).map(
        (r) =>
          [Number(r.startBlock), Number(r.endBlock)] satisfies [number, number],
      );
    });

    return intervalIntersectionMany(fragmentIntervals);
  };

  insertFactoryChildAddressLogs = async ({
    chainId,
    logs: rpcLogs,
  }: {
    chainId: number;
    logs: RpcLog[];
  }) => {
    await this.db.transaction().execute(async (tx) => {
      for (const rpcLog of rpcLogs) {
        await tx
          .insertInto("logs")
          .values({ ...rpcToSqliteLog(rpcLog), chainId })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
      }
    });
  };

  async *getFactoryChildAddresses({
    chainId,
    upToBlockNumber,
    factory,
    pageSize = 500,
  }: {
    chainId: number;
    upToBlockNumber: bigint;
    factory: FactoryCriteria;
    pageSize?: number;
  }) {
    const { address, eventSelector, childAddressLocation } = factory;

    const selectChildAddressExpression =
      buildFactoryChildAddressSelectExpression({ childAddressLocation });

    const baseQuery = this.db
      .selectFrom("logs")
      .select([selectChildAddressExpression.as("childAddress"), "blockNumber"])
      .where("chainId", "=", chainId)
      .where("address", "=", address)
      .where("topic0", "=", eventSelector)
      .where("blockNumber", "<=", encodeAsText(upToBlockNumber))
      .limit(pageSize);

    let cursor: BigIntText | undefined = undefined;

    while (true) {
      let query = baseQuery;

      if (cursor) {
        query = query.where("blockNumber", ">", cursor);
      }

      const batch = await query.execute();

      const lastRow = batch[batch.length - 1];
      if (lastRow) {
        cursor = lastRow.blockNumber;
      }

      if (batch.length > 0) {
        yield batch.map((a) => a.childAddress);
      }

      if (batch.length < pageSize) break;
    }
  }

  insertFactoryLogFilterInterval = async ({
    chainId,
    factory,
    block: rpcBlock,
    transactions: rpcTransactions,
    logs: rpcLogs,
    interval,
  }: {
    chainId: number;
    factory: FactoryCriteria;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("blocks")
        .values({ ...rpcToSqliteBlock(rpcBlock), chainId })
        .onConflict((oc) => oc.column("hash").doNothing())
        .execute();

      for (const rpcTransaction of rpcTransactions) {
        await tx
          .insertInto("transactions")
          .values({ ...rpcToSqliteTransaction(rpcTransaction), chainId })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();
      }

      for (const rpcLog of rpcLogs) {
        await tx
          .insertInto("logs")
          .values({ ...rpcToSqliteLog(rpcLog), chainId })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
      }

      await this._insertFactoryLogFilterInterval({
        tx,
        chainId,
        factories: [factory],
        interval,
      });
    });
  };

  getFactoryLogFilterIntervals = async ({
    chainId,
    factory,
  }: {
    chainId: number;
    factory: FactoryCriteria;
  }) => {
    const fragments = buildFactoryFragments({
      ...factory,
      chainId,
    });

    await Promise.all(
      fragments.map(async (fragment) => {
        return await this.db.transaction().execute(async (tx) => {
          const { id: factoryId } = await tx
            .insertInto("factories")
            .values(fragment)
            .onConflict((oc) => oc.doUpdateSet(fragment))
            .returningAll()
            .executeTakeFirstOrThrow();

          const existingIntervals = await tx
            .deleteFrom("factoryLogFilterIntervals")
            .where("factoryId", "=", factoryId)
            .returningAll()
            .execute();

          const mergedIntervals = intervalUnion(
            existingIntervals.map((i) => [
              Number(decodeToBigInt(i.startBlock)),
              Number(decodeToBigInt(i.endBlock)),
            ]),
          );

          const mergedIntervalRows = mergedIntervals.map(
            ([startBlock, endBlock]) => ({
              factoryId,
              startBlock: encodeAsText(startBlock),
              endBlock: encodeAsText(endBlock),
            }),
          );

          if (mergedIntervalRows.length > 0) {
            await tx
              .insertInto("factoryLogFilterIntervals")
              .values(mergedIntervalRows)
              .execute();
          }

          return mergedIntervals;
        });
      }),
    );

    const intervals = await this.db
      .with(
        "factoryFilterFragments(fragmentId, fragmentAddress, fragmentEventSelector, fragmentChildAddressLocation, fragmentTopic0, fragmentTopic1, fragmentTopic2, fragmentTopic3)",
        () =>
          sql`( values ${sql.join(
            fragments.map(
              (f) =>
                sql`( ${sql.val(f.id)}, ${sql.val(f.address)}, ${sql.val(
                  f.eventSelector,
                )}, ${sql.val(f.childAddressLocation)}, ${sql.val(
                  f.topic0,
                )}, ${sql.val(f.topic1)}, ${sql.val(f.topic2)}, ${sql.val(
                  f.topic3,
                )} )`,
            ),
          )} )`,
      )
      .selectFrom("factoryLogFilterIntervals")
      .leftJoin("factories", "factoryId", "factories.id")
      .innerJoin("factoryFilterFragments", (join) => {
        let baseJoin = join.on(({ and, cmpr }) =>
          and([
            cmpr("fragmentAddress", "=", sql.ref("address")),
            cmpr("fragmentEventSelector", "=", sql.ref("eventSelector")),
            cmpr(
              "fragmentChildAddressLocation",
              "=",
              sql.ref("childAddressLocation"),
            ),
          ]),
        );
        for (const idx_ of range(0, 4)) {
          baseJoin = baseJoin.on(({ or, cmpr }) => {
            const idx = idx_ as 0 | 1 | 2 | 3;
            return or([
              cmpr(`topic${idx}`, "is", null),
              cmpr(`fragmentTopic${idx}`, "=", sql.ref(`topic${idx}`)),
            ]);
          });
        }

        return baseJoin;
      })
      .select(["fragmentId", "startBlock", "endBlock"])
      .where("chainId", "=", chainId)
      .execute();

    const intervalsByFragment = intervals.reduce(
      (acc, cur) => {
        const { fragmentId, ...rest } = cur;
        acc[fragmentId] ||= [];
        acc[fragmentId].push({
          startBlock: decodeToBigInt(rest.startBlock),
          endBlock: decodeToBigInt(rest.endBlock),
        });
        return acc;
      },
      {} as Record<string, { startBlock: bigint; endBlock: bigint }[]>,
    );

    const fragmentIntervals = fragments.map((f) => {
      return (intervalsByFragment[f.id] ?? []).map(
        (r) =>
          [Number(r.startBlock), Number(r.endBlock)] satisfies [number, number],
      );
    });

    return intervalIntersectionMany(fragmentIntervals);
  };

  insertRealtimeBlock = async ({
    chainId,
    block: rpcBlock,
    transactions: rpcTransactions,
    logs: rpcLogs,
  }: {
    chainId: number;
    block: RpcBlock;
    transactions: RpcTransaction[];
    logs: RpcLog[];
  }) => {
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("blocks")
        .values({ ...rpcToSqliteBlock(rpcBlock), chainId })
        .onConflict((oc) => oc.column("hash").doNothing())
        .execute();

      for (const rpcTransaction of rpcTransactions) {
        await tx
          .insertInto("transactions")
          .values({ ...rpcToSqliteTransaction(rpcTransaction), chainId })
          .onConflict((oc) => oc.column("hash").doNothing())
          .execute();
      }

      for (const rpcLog of rpcLogs) {
        await tx
          .insertInto("logs")
          .values({ ...rpcToSqliteLog(rpcLog), chainId })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
      }
    });
  };

  insertRealtimeInterval = async ({
    chainId,
    logFilters,
    factories,
    interval,
  }: {
    chainId: number;
    logFilters: LogFilterCriteria[];
    factories: FactoryCriteria[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    await this.db.transaction().execute(async (tx) => {
      await this._insertLogFilterInterval({
        tx,
        chainId,
        logFilters: [
          ...logFilters,
          ...factories.map((f) => ({
            address: f.address,
            topics: [f.eventSelector],
          })),
        ],
        interval,
      });

      await this._insertFactoryLogFilterInterval({
        tx,
        chainId,
        factories,
        interval,
      });
    });
  };

  deleteRealtimeData = async ({
    chainId,
    fromBlock: fromBlock_,
  }: {
    chainId: number;
    fromBlock: bigint;
  }) => {
    const fromBlock = encodeAsText(fromBlock_);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom("blocks")
        .where("chainId", "=", chainId)
        .where("number", ">", fromBlock)
        .execute();
      await tx
        .deleteFrom("transactions")
        .where("chainId", "=", chainId)
        .where("blockNumber", ">", fromBlock)
        .execute();
      await tx
        .deleteFrom("logs")
        .where("chainId", "=", chainId)
        .where("blockNumber", ">", fromBlock)
        .execute();
      await tx
        .deleteFrom("rpcRequestResults")
        .where("chainId", "=", chainId)
        .where("blockNumber", ">", fromBlock)
        .execute();

      // Delete all intervals with a startBlock greater than fromBlock.
      // Then, if any intervals have an endBlock greater than fromBlock,
      // update their endBlock to equal fromBlock.
      await tx
        .deleteFrom("logFilterIntervals")
        .where(
          (qb) =>
            qb
              .selectFrom("logFilters")
              .select("logFilters.chainId")
              .whereRef("logFilters.id", "=", "logFilterIntervals.logFilterId")
              .limit(1),
          "=",
          chainId,
        )
        .where("startBlock", ">", fromBlock)
        .execute();
      await tx
        .updateTable("logFilterIntervals")
        .set({ endBlock: fromBlock })
        .where(
          (qb) =>
            qb
              .selectFrom("logFilters")
              .select("logFilters.chainId")
              .whereRef("logFilters.id", "=", "logFilterIntervals.logFilterId")
              .limit(1),
          "=",
          chainId,
        )
        .where("endBlock", ">", fromBlock)
        .execute();

      await tx
        .deleteFrom("factoryLogFilterIntervals")
        .where(
          (qb) =>
            qb
              .selectFrom("factories")
              .select("factories.chainId")
              .whereRef(
                "factories.id",
                "=",
                "factoryLogFilterIntervals.factoryId",
              )
              .limit(1),
          "=",
          chainId,
        )
        .where("startBlock", ">", fromBlock)
        .execute();
      await tx
        .updateTable("factoryLogFilterIntervals")
        .set({ endBlock: fromBlock })
        .where(
          (qb) =>
            qb
              .selectFrom("factories")
              .select("factories.chainId")
              .whereRef(
                "factories.id",
                "=",
                "factoryLogFilterIntervals.factoryId",
              )
              .limit(1),
          "=",
          chainId,
        )
        .where("endBlock", ">", fromBlock)
        .execute();
    });
  };

  /** SYNC HELPER METHODS */

  private _insertLogFilterInterval = async ({
    tx,
    chainId,
    logFilters,
    interval: { startBlock, endBlock },
  }: {
    tx: KyselyTransaction<SyncStoreTables>;
    chainId: number;
    logFilters: LogFilterCriteria[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    const logFilterFragments = logFilters
      .map((logFilter) => buildLogFilterFragments({ ...logFilter, chainId }))
      .flat();

    await Promise.all(
      logFilterFragments.map(async (logFilterFragment) => {
        const { id: logFilterId } = await tx
          .insertInto("logFilters")
          .values(logFilterFragment)
          .onConflict((oc) => oc.doUpdateSet(logFilterFragment))
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto("logFilterIntervals")
          .values({
            logFilterId,
            startBlock: encodeAsText(startBlock),
            endBlock: encodeAsText(endBlock),
          })
          .execute();
      }),
    );
  };

  private _insertFactoryLogFilterInterval = async ({
    tx,
    chainId,
    factories,
    interval: { startBlock, endBlock },
  }: {
    tx: KyselyTransaction<SyncStoreTables>;
    chainId: number;
    factories: FactoryCriteria[];
    interval: { startBlock: bigint; endBlock: bigint };
  }) => {
    const factoryFragments = factories
      .map((factory) => buildFactoryFragments({ ...factory, chainId }))
      .flat();

    await Promise.all(
      factoryFragments.map(async (fragment) => {
        const { id: factoryId } = await tx
          .insertInto("factories")
          .values(fragment)
          .onConflict((oc) => oc.doUpdateSet(fragment))
          .returningAll()
          .executeTakeFirstOrThrow();

        await tx
          .insertInto("factoryLogFilterIntervals")
          .values({
            factoryId,
            startBlock: encodeAsText(startBlock),
            endBlock: encodeAsText(endBlock),
          })
          .execute();
      }),
    );
  };

  /** CONTRACT READS */

  insertRpcRequestResult = async ({
    blockNumber,
    chainId,
    request,
    result,
  }: {
    blockNumber: bigint;
    chainId: number;
    request: string;
    result: string;
  }) => {
    await this.db
      .insertInto("rpcRequestResults")
      .values({
        request,
        blockNumber: encodeAsText(blockNumber),
        chainId,
        result,
      })
      .onConflict((oc) => oc.doUpdateSet({ result }))
      .execute();
  };

  getRpcRequestResult = async ({
    blockNumber,
    chainId,
    request,
  }: {
    blockNumber: bigint;
    chainId: number;
    request: string;
  }) => {
    const rpcRequestResult = await this.db
      .selectFrom("rpcRequestResults")
      .selectAll()
      .where("blockNumber", "=", encodeAsText(blockNumber))
      .where("chainId", "=", chainId)
      .where("request", "=", request)
      .executeTakeFirst();

    return rpcRequestResult
      ? {
          ...rpcRequestResult,
          blockNumber: decodeToBigInt(rpcRequestResult.blockNumber),
        }
      : null;
  };

  async *getLogEvents({
    fromTimestamp,
    toTimestamp,
    logFilters = [],
    factories = [],
    pageSize = 10_000,
  }: {
    fromTimestamp: number;
    toTimestamp: number;
    logFilters?: {
      name: string;
      chainId: number;
      criteria: LogFilterCriteria;
      fromBlock?: number;
      toBlock?: number;
      includeEventSelectors?: Hex[];
    }[];
    factories?: {
      name: string;
      chainId: number;
      criteria: FactoryCriteria;
      fromBlock?: number;
      toBlock?: number;
      includeEventSelectors?: Hex[];
    }[];
    pageSize: number;
  }) {
    const eventSourceNames = [
      ...logFilters.map((f) => f.name),
      ...factories.map((f) => f.name),
    ];

    const baseQuery = this.db
      .with(
        "eventSources(eventSource_name)",
        () =>
          sql`( values ${sql.join(
            eventSourceNames.map((name) => sql`( ${sql.val(name)} )`),
          )} )`,
      )
      .selectFrom("logs")
      .leftJoin("blocks", "blocks.hash", "logs.blockHash")
      .leftJoin("transactions", "transactions.hash", "logs.transactionHash")
      .innerJoin("eventSources", (join) => join.onTrue())
      .select([
        "eventSource_name",

        "logs.address as log_address",
        "logs.blockHash as log_blockHash",
        "logs.blockNumber as log_blockNumber",
        "logs.chainId as log_chainId",
        "logs.data as log_data",
        "logs.id as log_id",
        "logs.logIndex as log_logIndex",
        "logs.topic0 as log_topic0",
        "logs.topic1 as log_topic1",
        "logs.topic2 as log_topic2",
        "logs.topic3 as log_topic3",
        "logs.transactionHash as log_transactionHash",
        "logs.transactionIndex as log_transactionIndex",

        "blocks.baseFeePerGas as block_baseFeePerGas",
        // "blocks.chainId as block_chainId",
        "blocks.difficulty as block_difficulty",
        "blocks.extraData as block_extraData",
        "blocks.gasLimit as block_gasLimit",
        "blocks.gasUsed as block_gasUsed",
        "blocks.hash as block_hash",
        "blocks.logsBloom as block_logsBloom",
        "blocks.miner as block_miner",
        "blocks.mixHash as block_mixHash",
        "blocks.nonce as block_nonce",
        "blocks.number as block_number",
        "blocks.parentHash as block_parentHash",
        "blocks.receiptsRoot as block_receiptsRoot",
        "blocks.sha3Uncles as block_sha3Uncles",
        "blocks.size as block_size",
        "blocks.stateRoot as block_stateRoot",
        "blocks.timestamp as block_timestamp",
        "blocks.totalDifficulty as block_totalDifficulty",
        "blocks.transactionsRoot as block_transactionsRoot",

        "transactions.accessList as tx_accessList",
        "transactions.blockHash as tx_blockHash",
        "transactions.blockNumber as tx_blockNumber",
        // "transactions.chainId as tx_chainId",
        "transactions.from as tx_from",
        "transactions.gas as tx_gas",
        "transactions.gasPrice as tx_gasPrice",
        "transactions.hash as tx_hash",
        "transactions.input as tx_input",
        "transactions.maxFeePerGas as tx_maxFeePerGas",
        "transactions.maxPriorityFeePerGas as tx_maxPriorityFeePerGas",
        "transactions.nonce as tx_nonce",
        "transactions.r as tx_r",
        "transactions.s as tx_s",
        "transactions.to as tx_to",
        "transactions.transactionIndex as tx_transactionIndex",
        "transactions.type as tx_type",
        "transactions.value as tx_value",
        "transactions.v as tx_v",
      ])
      .where("blocks.timestamp", ">=", encodeAsText(fromTimestamp))
      .where("blocks.timestamp", "<=", encodeAsText(toTimestamp))
      .orderBy("blocks.timestamp", "asc")
      .orderBy("logs.chainId", "asc")
      .orderBy("blocks.number", "asc")
      .orderBy("logs.logIndex", "asc");

    const buildLogFilterCmprs = ({
      where,
      logFilter,
    }: {
      where: ExpressionBuilder<any, any>;
      logFilter: (typeof logFilters)[number];
    }) => {
      const { cmpr, or } = where;
      const cmprs = [];

      cmprs.push(cmpr("eventSource_name", "=", logFilter.name));
      cmprs.push(cmpr("logs.chainId", "=", logFilter.chainId));

      if (logFilter.criteria.address) {
        // If it's an array of length 1, collapse it.
        const address =
          Array.isArray(logFilter.criteria.address) &&
          logFilter.criteria.address.length === 1
            ? logFilter.criteria.address[0]
            : logFilter.criteria.address;
        if (Array.isArray(address)) {
          cmprs.push(or(address.map((a) => cmpr("logs.address", "=", a))));
        } else {
          cmprs.push(cmpr("logs.address", "=", address));
        }
      }

      if (logFilter.criteria.topics) {
        for (const idx_ of range(0, 4)) {
          const idx = idx_ as 0 | 1 | 2 | 3;
          // If it's an array of length 1, collapse it.
          const raw = logFilter.criteria.topics[idx] ?? null;
          if (raw === null) continue;
          const topic = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
          if (Array.isArray(topic)) {
            cmprs.push(or(topic.map((a) => cmpr(`logs.topic${idx}`, "=", a))));
          } else {
            cmprs.push(cmpr(`logs.topic${idx}`, "=", topic));
          }
        }
      }

      if (logFilter.fromBlock) {
        cmprs.push(
          cmpr("blocks.number", ">=", encodeAsText(logFilter.fromBlock)),
        );
      }

      if (logFilter.toBlock) {
        cmprs.push(
          cmpr("blocks.number", "<=", encodeAsText(logFilter.toBlock)),
        );
      }

      return cmprs;
    };

    const buildFactoryCmprs = ({
      where,
      factory,
    }: {
      where: ExpressionBuilder<any, any>;
      factory: (typeof factories)[number];
    }) => {
      const { cmpr, selectFrom } = where;
      const cmprs = [];

      cmprs.push(cmpr("eventSource_name", "=", factory.name));
      cmprs.push(cmpr("logs.chainId", "=", factory.chainId));

      const selectChildAddressExpression =
        buildFactoryChildAddressSelectExpression({
          childAddressLocation: factory.criteria.childAddressLocation,
        });

      cmprs.push(
        cmpr(
          "logs.address",
          "in",
          selectFrom("logs")
            .select(selectChildAddressExpression.as("childAddress"))
            .where("chainId", "=", factory.chainId)
            .where("address", "=", factory.criteria.address)
            .where("topic0", "=", factory.criteria.eventSelector),
        ),
      );

      if (factory.fromBlock) {
        cmprs.push(
          cmpr("blocks.number", ">=", encodeAsText(factory.fromBlock)),
        );
      }

      if (factory.toBlock) {
        cmprs.push(cmpr("blocks.number", "<=", encodeAsText(factory.toBlock)));
      }

      return cmprs;
    };

    // Get full log objects, including the includeEventSelectors clause.
    const includedLogsBaseQuery = baseQuery
      .where((where) => {
        const { cmpr, and, or } = where;
        const logFilterCmprs = logFilters.map((logFilter) => {
          const cmprs = buildLogFilterCmprs({ where, logFilter });
          if (logFilter.includeEventSelectors) {
            cmprs.push(
              or(
                logFilter.includeEventSelectors.map((t) =>
                  cmpr("logs.topic0", "=", t),
                ),
              ),
            );
          }
          return and(cmprs);
        });

        const factoryCmprs = factories.map((factory) => {
          const cmprs = buildFactoryCmprs({ where, factory });
          if (factory.includeEventSelectors) {
            cmprs.push(
              or(
                factory.includeEventSelectors.map((t) =>
                  cmpr("logs.topic0", "=", t),
                ),
              ),
            );
          }
          return and(cmprs);
        });

        return or([...logFilterCmprs, ...factoryCmprs]);
      })
      .orderBy("blocks.timestamp", "asc")
      .orderBy("logs.chainId", "asc")
      .orderBy("blocks.number", "asc")
      .orderBy("logs.logIndex", "asc");

    // Get total count of matching logs, grouped by log filter and event selector.
    const eventCountsQuery = baseQuery
      .clearSelect()
      .select([
        "eventSource_name",
        "logs.topic0",
        this.db.fn.count("logs.id").as("count"),
      ])
      .where((where) => {
        const { and, or } = where;

        // NOTE: Not adding the includeEventSelectors clause here.
        const logFilterCmprs = logFilters.map((logFilter) =>
          and(buildLogFilterCmprs({ where, logFilter })),
        );

        const factoryCmprs = factories.map((factory) =>
          and(buildFactoryCmprs({ where, factory })),
        );

        return or([...logFilterCmprs, ...factoryCmprs]);
      })
      .groupBy(["eventSource_name", "logs.topic0"]);

    // Fetch the event counts once and include it in every response.
    const eventCountsRaw = await eventCountsQuery.execute();
    const eventCounts = eventCountsRaw.map((c) => ({
      eventSourceName: String(c.eventSource_name),
      selector: c.topic0 as Hex,
      count: Number(c.count),
    }));

    let cursor:
      | {
          timestamp: BigIntText;
          chainId: number;
          blockNumber: BigIntText;
          logIndex: number;
        }
      | undefined = undefined;

    while (true) {
      let query = includedLogsBaseQuery.limit(pageSize);
      if (cursor) {
        // See this comment for an explanation of the cursor logic.
        // https://stackoverflow.com/a/38017813
        // This is required to avoid skipping logs that have the same timestamp.
        query = query.where(({ and, or, cmpr }) => {
          const { timestamp, chainId, blockNumber, logIndex } = cursor!;
          return and([
            cmpr("blocks.timestamp", ">=", timestamp),
            or([
              cmpr("blocks.timestamp", ">", timestamp),
              and([
                cmpr("logs.chainId", ">=", chainId),
                or([
                  cmpr("logs.chainId", ">", chainId),
                  and([
                    cmpr("blocks.number", ">=", blockNumber),
                    or([
                      cmpr("blocks.number", ">", blockNumber),
                      cmpr("logs.logIndex", ">", logIndex),
                    ]),
                  ]),
                ]),
              ]),
            ]),
          ]);
        });
      }

      const requestedLogs = await query.execute();

      const events = requestedLogs.map((_row) => {
        // Without this cast, the block_ and tx_ fields are all nullable
        // which makes this very annoying. Should probably add a runtime check
        // that those fields are indeed present before continuing here.
        const row = _row as NonNull<(typeof requestedLogs)[number]>;
        return {
          eventSourceName: row.eventSource_name,
          log: {
            address: row.log_address,
            blockHash: row.log_blockHash,
            blockNumber: decodeToBigInt(row.log_blockNumber),
            data: row.log_data,
            id: row.log_id,
            logIndex: Number(row.log_logIndex),
            removed: false,
            topics: [
              row.log_topic0,
              row.log_topic1,
              row.log_topic2,
              row.log_topic3,
            ].filter((t): t is Hex => t !== null) as [Hex, ...Hex[]] | [],
            transactionHash: row.log_transactionHash,
            transactionIndex: Number(row.log_transactionIndex),
          },
          block: {
            baseFeePerGas: row.block_baseFeePerGas
              ? decodeToBigInt(row.block_baseFeePerGas)
              : null,
            difficulty: decodeToBigInt(row.block_difficulty),
            extraData: row.block_extraData,
            gasLimit: decodeToBigInt(row.block_gasLimit),
            gasUsed: decodeToBigInt(row.block_gasUsed),
            hash: row.block_hash,
            logsBloom: row.block_logsBloom,
            miner: row.block_miner,
            mixHash: row.block_mixHash,
            nonce: row.block_nonce,
            number: decodeToBigInt(row.block_number),
            parentHash: row.block_parentHash,
            receiptsRoot: row.block_receiptsRoot,
            sha3Uncles: row.block_sha3Uncles,
            size: decodeToBigInt(row.block_size),
            stateRoot: row.block_stateRoot,
            timestamp: decodeToBigInt(row.block_timestamp),
            totalDifficulty: decodeToBigInt(row.block_totalDifficulty),
            transactionsRoot: row.block_transactionsRoot,
          },
          transaction: {
            blockHash: row.tx_blockHash,
            blockNumber: decodeToBigInt(row.tx_blockNumber),
            from: row.tx_from,
            gas: decodeToBigInt(row.tx_gas),
            hash: row.tx_hash,
            input: row.tx_input,
            nonce: Number(row.tx_nonce),
            r: row.tx_r,
            s: row.tx_s,
            to: row.tx_to,
            transactionIndex: Number(row.tx_transactionIndex),
            value: decodeToBigInt(row.tx_value),
            v: decodeToBigInt(row.tx_v),
            ...(row.tx_type === "0x0"
              ? {
                  type: "legacy",
                  gasPrice: decodeToBigInt(row.tx_gasPrice),
                }
              : row.tx_type === "0x1"
              ? {
                  type: "eip2930",
                  gasPrice: decodeToBigInt(row.tx_gasPrice),
                  accessList: JSON.parse(row.tx_accessList),
                }
              : row.tx_type === "0x2"
              ? {
                  type: "eip1559",
                  maxFeePerGas: decodeToBigInt(row.tx_maxFeePerGas),
                  maxPriorityFeePerGas: decodeToBigInt(
                    row.tx_maxPriorityFeePerGas,
                  ),
                }
              : row.tx_type === "0x7e"
              ? {
                  type: "deposit",
                  maxFeePerGas: decodeToBigInt(row.tx_maxFeePerGas),
                  maxPriorityFeePerGas: decodeToBigInt(
                    row.tx_maxPriorityFeePerGas,
                  ),
                }
              : {
                  type: row.tx_type,
                }),
          },
          chainId: row.log_chainId,
        } satisfies {
          eventSourceName: string;
          log: Log;
          block: Block;
          transaction: Transaction;
          chainId: number;
        };
      });

      const lastRow = requestedLogs[requestedLogs.length - 1];
      if (lastRow) {
        cursor = {
          timestamp: lastRow.block_timestamp!,
          chainId: lastRow.log_chainId,
          blockNumber: lastRow.block_number!,
          logIndex: lastRow.log_logIndex,
        };
      }

      const lastEventBlockTimestamp = lastRow?.block_timestamp;
      const pageEndsAtTimestamp = lastEventBlockTimestamp
        ? Number(decodeToBigInt(lastEventBlockTimestamp))
        : toTimestamp;

      yield {
        events,
        metadata: {
          pageEndsAtTimestamp,
          counts: eventCounts,
        },
      };

      if (events.length < pageSize) break;
    }
  }
}

function buildFactoryChildAddressSelectExpression({
  childAddressLocation,
}: {
  childAddressLocation: FactoryCriteria["childAddressLocation"];
}) {
  if (childAddressLocation.startsWith("offset")) {
    const childAddressOffset = Number(childAddressLocation.substring(6));
    const start = 2 + 12 * 2 + childAddressOffset * 2 + 1;
    const length = 20 * 2;
    return sql<Hex>`'0x' || substring(data, ${start}, ${length})`;
  } else {
    const start = 2 + 12 * 2 + 1;
    const length = 20 * 2;
    return sql<Hex>`'0x' || substring(${sql.ref(
      childAddressLocation,
    )}, ${start}, ${length})`;
  }
}
