import { parseSubscription } from "@subboost/core/parser";
import { stripImportedNodeControlFields } from "@subboost/core/subscription/imported-node-controls";
import {
  keepOnlyValidNodeSourceIds,
  normalizeNodeOriginName,
} from "@subboost/core/subscription/node-source-state";
import {
  detachSourceNodesFromState,
  type DeletedNodeDescriptor,
  mergeParsedSourceNodes,
  prepareSourceParsedNodes,
} from "@subboost/core/subscription/source-node-refresh";
import {
  hasSubscriptionUserInfo,
  mergeSubscriptionUserInfo,
  normalizeSubscriptionUserInfo,
  parseSubscriptionUserInfo,
  resolveSubscriptionUserInfo,
  type SubscriptionUserInfo,
} from "@subboost/core/subscription/subscription-userinfo";
import {
  pickSubscriptionResponseInfoFromHeaders,
  type SubscriptionResponseInfo,
} from "@subboost/core/subscription/subscription-response-info";
import type { SubscriptionImportErrorCategory } from "@subboost/core/subscription/import-error";
import type { ParsedNode } from "@subboost/core/types/node";
import { composeNodeNameRenameMaps } from "@subboost/core/subscription/node-name-references";
import { normalizeSavedSourcesForPersistence, type SavedSource, type SavedSourceType } from "./saved-sources";

type UrlNodeFetchResult = {
  ok: boolean;
  nodes: ParsedNode[];
  errors?: string[];
  headers?: Record<string, string>;
  error?: string;
  errorInfo?: {
    category?: SubscriptionImportErrorCategory;
    message?: string;
    detail?: string;
    httpStatus?: number;
  } | null;
  publicReason?: string | null;
  responseStatus?: number;
};

export type RefreshNodeSnapshotFailedSource = {
  id: string;
  type: SavedSourceType;
  content: string;
  errorMessage: string;
  errorCategory?: SubscriptionImportErrorCategory;
  httpStatus?: number;
  publicReason?: string | null;
};

export type RefreshNodeSnapshotOptions = {
  config: Record<string, unknown>;
  urls: string[];
  storedNodes: ParsedNode[];
  fetchUrlNodes: (source: SavedSource) => Promise<UrlNodeFetchResult>;
  fetchUrlUserInfo?: (source: SavedSource) => Promise<Record<string, string> | undefined>;
};

export type RefreshNodeSnapshotResult = {
  nodes: ParsedNode[];
  renameMap?: ReadonlyMap<string, string>;
  subscriptionInfo: SubscriptionResponseInfo;
  savedSources: SavedSource[];
  attemptedUrlFetch: boolean;
  usedUrlFetch: boolean;
  refreshableSourceCount: number;
  refreshedSourceCount: number;
  refreshedUrlSourceCount: number;
  refreshedStaticSourceCount: number;
  detachedSourceCount: number;
  failedSourceCount: number;
  failedSources: RefreshNodeSnapshotFailedSource[];
};

function getDeletedNodeNames(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.deletedNodeNames)) return [];
  return (config.deletedNodeNames as unknown[])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDeletedNodes(config: Record<string, unknown>): DeletedNodeDescriptor[] {
  if (!Array.isArray(config.deletedNodes)) return [];
  return (config.deletedNodes as unknown[]).filter(
    (item): item is DeletedNodeDescriptor => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

export function resolveSmartNodeMatchingEnabled(config: Record<string, unknown>): boolean {
  return config.smartNodeMatchingEnabled !== false;
}

type StableMetadataState = {
  value?: string;
  conflicted: boolean;
};

function mergeStableMetadataValue(state: StableMetadataState, nextValue: string | undefined) {
  if (!nextValue || state.conflicted) return;
  if (!state.value) {
    state.value = nextValue;
    return;
  }
  if (state.value !== nextValue) {
    state.value = undefined;
    state.conflicted = true;
  }
}

export async function refreshNodeSnapshot(
  options: RefreshNodeSnapshotOptions
): Promise<RefreshNodeSnapshotResult> {
  const savedSources = normalizeSavedSourcesForPersistence(options.config.sources, {
    fallbackUrls: options.urls,
  });
  let refreshedSavedSources = savedSources.map((source) => ({ ...source }));
  const validSourceIds = new Set(savedSources.map((source) => source.id));
  const deletedNodeNames = getDeletedNodeNames(options.config);
  const deletedNodes = getDeletedNodes(options.config);
  const smartNodeMatchingEnabled = resolveSmartNodeMatchingEnabled(options.config);

  let currentNodes = options.storedNodes
    .map(stripImportedNodeControlFields)
    .map(normalizeNodeOriginName)
    .map((node) => keepOnlyValidNodeSourceIds(node, validSourceIds))
    .filter(Boolean) as ParsedNode[];

  const subscriptionInfo: SubscriptionResponseInfo = {};
  const profileWebPageUrlState: StableMetadataState = { conflicted: false };
  const planNameState: StableMetadataState = { conflicted: false };
  const attemptedUrlFetch = savedSources.some((source) => source.type === "url" && !source.useProxyProviders);
  let usedUrlFetch = false;
  let refreshableSourceCount = 0;
  let refreshedSourceCount = 0;
  let refreshedUrlSourceCount = 0;
  let refreshedStaticSourceCount = 0;
  let detachedSourceCount = 0;
  let failedSourceCount = 0;
  const failedSources: RefreshNodeSnapshotFailedSource[] = [];
  let renameMap = new Map<string, string>();

  const recordFailedSource = (
    source: SavedSource,
    errorMessage: string,
    extra: {
      errorCategory?: SubscriptionImportErrorCategory;
      httpStatus?: number;
      publicReason?: string | null;
    } = {}
  ) => {
    failedSourceCount += 1;
    failedSources.push({
      id: source.id,
      type: source.type,
      content: source.content,
      errorMessage,
      ...extra,
    });
  };

  const mergeResponseMetadata = (headers?: Record<string, string>) => {
    const responseInfo = pickSubscriptionResponseInfoFromHeaders(headers);
    mergeStableMetadataValue(profileWebPageUrlState, responseInfo.profileWebPageUrl);
    mergeStableMetadataValue(planNameState, responseInfo.planName);
  };

  const updateSourceSubscriptionInfo = (sourceId: string, info: SubscriptionUserInfo | undefined) => {
    const index = refreshedSavedSources.findIndex((source) => source.id === sourceId);
    if (index < 0) return;

    const normalized = normalizeSubscriptionUserInfo(info);
    if (hasSubscriptionUserInfo(normalized)) {
      refreshedSavedSources = refreshedSavedSources.map((source, i) =>
        i === index ? { ...source, subscriptionUserInfo: normalized } : source
      );
      return;
    }

    refreshedSavedSources = refreshedSavedSources.map((source, i) => {
      if (i !== index) return source;
      const next = { ...source };
      delete next.subscriptionUserInfo;
      return next;
    });
  };

  // 记录本次实际应用到节点名上的前缀，作为下一次刷新的「上次自动名」基线。
  // 没有这一步，刷新时 previousAutoName 会用空前缀算，带前缀的旧名会被判成用户手改名，
  // 导致改前缀后节点名不再更新（清空前缀时同样去不掉）。
  const updateSourceNodePrefix = (sourceId: string, nodePrefix: string | undefined) => {
    const prefix = typeof nodePrefix === "string" ? nodePrefix.trim() : "";
    refreshedSavedSources = refreshedSavedSources.map((source) => {
      if (source.id !== sourceId) return source;
      const next = { ...source };
      if (prefix) {
        next.lastParsedNodePrefix = prefix;
      } else {
        delete next.lastParsedNodePrefix;
      }
      return next;
    });
  };

  // 每个 URL 源对聚合用量的唯一贡献。写入即覆盖：同一个源先按主抓取响应头记账，
  // 专用 userinfo 抓取拿到更准确的口径后替换掉，最终只累加一次。
  const sourceUserInfo = new Map<string, SubscriptionUserInfo>();

  // 先用上次成功抓取的用量占位：机场临时不可达、或这次响应里没有
  // subscription-userinfo 时，订阅仍显示上一次拿到的真实总量/已用，
  // 而不是退化成“剩余量当总量、upload/download 恒为 0”。
  for (const source of savedSources) {
    if (source.type !== "url" || source.useProxyProviders) continue;
    const seeded = normalizeSubscriptionUserInfo(source.subscriptionUserInfo);
    if (hasSubscriptionUserInfo(seeded)) sourceUserInfo.set(source.id, seeded);
  }

  const recordSourceUserInfo = (sourceId: string, info: SubscriptionUserInfo | undefined) => {
    const normalized = normalizeSubscriptionUserInfo(info);
    // 没有可用流量头时保留上一次的记账，不要清零。
    if (!hasSubscriptionUserInfo(normalized)) return;
    updateSourceSubscriptionInfo(sourceId, normalized);
    sourceUserInfo.set(sourceId, normalized);
  };

  const shouldFetchSupplementalUserInfoForSource = (source: SavedSource): boolean => {
    return Boolean(source.userinfoUrl || source.userinfoUserAgent);
  };

  for (const source of savedSources) {
    if (source.type === "url" && source.useProxyProviders) {
      const detached = detachSourceNodesFromState(currentNodes, source.id);
      if (detached.nodes.length !== currentNodes.length) {
        detachedSourceCount += 1;
        refreshedSourceCount += 1;
      }
      currentNodes = detached.nodes;
      if (
        typeof options.fetchUrlUserInfo === "function" &&
        shouldFetchSupplementalUserInfoForSource(source)
      ) {
        const headers = await options.fetchUrlUserInfo(source);
        if (headers) {
          mergeResponseMetadata(headers);
          const header = headers["subscription-userinfo"];
          recordSourceUserInfo(
            source.id,
            header ? resolveSubscriptionUserInfo(parseSubscriptionUserInfo(header)) : undefined
          );
        }
      }
      continue;
    }

    refreshableSourceCount += 1;

    if (source.type === "url") {
      const fetched = await options.fetchUrlNodes(source);
      mergeResponseMetadata(fetched.headers);
      const userInfoHeader = fetched.headers?.["subscription-userinfo"];
      const rawUserInfo = userInfoHeader ? parseSubscriptionUserInfo(userInfoHeader) : undefined;
      const resolvedUserInfo = resolveSubscriptionUserInfo(
        rawUserInfo,
        fetched.ok ? fetched.nodes : []
      );
      // 主抓取拿到的用量先记为该源的贡献，专用 userinfo 抓取稍后可以覆盖它：
      // 机场常常只对 GET 返回 header，补充抓取失败时也不能把这份数据丢掉。

      if (!fetched.ok || fetched.nodes.length === 0) {
        const errorInfo = fetched.errorInfo ?? null;
        const firstParseError =
          Array.isArray(fetched.errors) && typeof fetched.errors[0] === "string"
            ? fetched.errors[0]
            : null;
        const errorMessage =
          errorInfo?.detail ||
          errorInfo?.message ||
          fetched.error ||
          firstParseError ||
          "未解析到可用节点";
        recordFailedSource(source, errorMessage, {
          errorCategory: errorInfo?.category ?? (firstParseError ? "parse" : undefined),
          httpStatus: errorInfo?.httpStatus ?? fetched.responseStatus,
          publicReason: fetched.publicReason ?? null,
        });
        continue;
      }
      recordSourceUserInfo(source.id, resolvedUserInfo);

      const parsedNodes = prepareSourceParsedNodes(fetched.nodes, {
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        currentNodePrefix: source.nodePrefix,
      });
      const merged = mergeParsedSourceNodes(currentNodes, parsedNodes, deletedNodeNames, {
        sourceId: source.id,
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        lastTag: source.lastParsedTag,
        lastNameTemplate: source.lastParsedNameTemplate,
        lastNodePrefix: source.lastParsedNodePrefix,
        treatAsNewSource: Boolean(
          source.lastParsedContent &&
            source.lastParsedContent.trim() &&
            source.lastParsedContent.trim() !== source.content.trim()
        ),
        smartNodeMatchingEnabled,
        deletedNodes,
      });

      renameMap = composeNodeNameRenameMaps(renameMap, merged.renameMap);
      currentNodes = merged.nodes;
      updateSourceNodePrefix(source.id, source.nodePrefix);
      usedUrlFetch = true;
      refreshedSourceCount += 1;
      refreshedUrlSourceCount += 1;
      continue;
    }

    try {
      const parsed = parseSubscription(source.content);
      const resolvedUserInfo = resolveSubscriptionUserInfo(undefined, parsed.nodes);
      if (hasSubscriptionUserInfo(resolvedUserInfo)) {
        mergeSubscriptionUserInfo(subscriptionInfo, resolvedUserInfo);
      }
      if (parsed.nodes.length === 0) {
        recordFailedSource(source, "未解析到可用节点", { errorCategory: "parse" });
        continue;
      }
      updateSourceSubscriptionInfo(source.id, resolvedUserInfo);

      const parsedNodes = prepareSourceParsedNodes(parsed.nodes, {
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        currentNodePrefix: source.nodePrefix,
      });
      const merged = mergeParsedSourceNodes(currentNodes, parsedNodes, deletedNodeNames, {
        sourceId: source.id,
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        lastTag: source.lastParsedTag,
        lastNameTemplate: source.lastParsedNameTemplate,
        lastNodePrefix: source.lastParsedNodePrefix,
        treatAsNewSource: false,
        smartNodeMatchingEnabled,
        deletedNodes,
      });

      renameMap = composeNodeNameRenameMaps(renameMap, merged.renameMap);
      currentNodes = merged.nodes;
      updateSourceNodePrefix(source.id, source.nodePrefix);
      refreshedSourceCount += 1;
      refreshedStaticSourceCount += 1;
    } catch (error) {
      recordFailedSource(source, error instanceof Error ? error.message : "解析失败", {
        errorCategory: "parse",
      });
    }
  }

  // 补充抓取只在两种情况下还有意义：该源配了专用 userinfo 抓取（口径更准，
  // 用来覆盖主抓取按响应头记下的值），或主抓取根本没拿到用量。
  if (typeof options.fetchUrlUserInfo === "function" && usedUrlFetch) {
    for (const source of savedSources) {
      if (source.type !== "url" || source.useProxyProviders) continue;
      if (sourceUserInfo.has(source.id) && !shouldFetchSupplementalUserInfoForSource(source)) continue;
      const headers = await options.fetchUrlUserInfo(source);
      if (!headers) continue;
      mergeResponseMetadata(headers);
      const header = headers["subscription-userinfo"];
      if (!header) continue;
      // 专用抓取拿到的是机场真实用量，覆盖该源先前按响应头记下的贡献。
      recordSourceUserInfo(
        source.id,
        resolveSubscriptionUserInfo(parseSubscriptionUserInfo(header))
      );
    }
  }

  for (const info of sourceUserInfo.values()) {
    mergeSubscriptionUserInfo(subscriptionInfo, info);
  }

  if (!profileWebPageUrlState.conflicted && profileWebPageUrlState.value) {
    subscriptionInfo.profileWebPageUrl = profileWebPageUrlState.value;
  }
  if (!planNameState.conflicted && planNameState.value) {
    subscriptionInfo.planName = planNameState.value;
  }

  return {
    nodes: currentNodes,
    renameMap,
    subscriptionInfo,
    savedSources: refreshedSavedSources,
    attemptedUrlFetch,
    usedUrlFetch,
    refreshableSourceCount,
    refreshedSourceCount,
    refreshedUrlSourceCount,
    refreshedStaticSourceCount,
    detachedSourceCount,
    failedSourceCount,
    failedSources,
  };
}
