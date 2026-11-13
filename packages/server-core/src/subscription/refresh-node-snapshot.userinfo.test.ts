import { describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { refreshNodeSnapshot } from "./refresh-node-snapshot";

type Options = Parameters<typeof refreshNodeSnapshot>[0];
type FetchUrlNodes = Options["fetchUrlNodes"];
type FetchUrlUserInfo = NonNullable<Options["fetchUrlUserInfo"]>;

const baseNode: ParsedNode = {
  name: "Node",
  type: "trojan",
  server: "node.example.com",
  port: 443,
  password: "secret",
};

function okNodes(sourceId: string, headers: Record<string, string> = {}) {
  return {
    ok: true,
    nodes: [{ ...baseNode, name: `Node ${sourceId}`, server: `${sourceId}.example.com` }],
    headers,
  };
}

describe("refreshNodeSnapshot 流量记账", () => {
  it("专用 userinfo 抓取没拿到 header 时回退主抓取响应头", async () => {
    const fetchUrlNodes = vi.fn(async (_source: Parameters<FetchUrlNodes>[0]): ReturnType<FetchUrlNodes> =>
      okNodes("url-a", { "subscription-userinfo": "upload=2048; download=4096; total=1048576" })
    );
    const fetchUrlUserInfo = vi.fn(async (_source: Parameters<FetchUrlUserInfo>[0]): ReturnType<FetchUrlUserInfo> => ({}));

    const result = await refreshNodeSnapshot({
      config: {
        sources: [
          {
            id: "url-a",
            type: "url",
            content: "https://a.example.com/sub",
            userinfoUrl: "https://a.example.com/userinfo",
          },
        ],
      },
      urls: [],
      storedNodes: [],
      fetchUrlNodes,
      fetchUrlUserInfo,
    });

    expect(fetchUrlUserInfo).toHaveBeenCalledTimes(1);
    expect(result.subscriptionInfo).toMatchObject({ upload: 2048, download: 4096, total: 1048576 });
  });

  it("响应里没有 subscription-userinfo 时保留上次拿到的用量", async () => {
    const result = await refreshNodeSnapshot({
      config: {
        sources: [
          {
            id: "url",
            type: "url",
            content: "https://url.example.com/sub",
            subscriptionUserInfo: { upload: 1, download: 2, total: 4096 },
          },
        ],
      },
      urls: [],
      storedNodes: [],
      fetchUrlNodes: vi.fn(async (_source: Parameters<FetchUrlNodes>[0]): ReturnType<FetchUrlNodes> => okNodes("url")),
    });

    expect(result.savedSources[0]).toHaveProperty("subscriptionUserInfo");
    expect(result.subscriptionInfo).toMatchObject({ upload: 1, download: 2, total: 4096 });
  });

  it("来源抓取失败时仍用上次的用量上报，而不是退化成 0", async () => {
    const result = await refreshNodeSnapshot({
      config: {
        sources: [
          {
            id: "airport",
            type: "url",
            content: "https://airport.example.com/sub",
            subscriptionUserInfo: {
              upload: 329579478,
              download: 4222002916,
              total: 64424509440,
              expire: 1796192081,
            },
          },
        ],
      },
      urls: [],
      storedNodes: [{ ...baseNode, name: "Airport Node" }],
      fetchUrlNodes: vi.fn(async (_source: Parameters<FetchUrlNodes>[0]): ReturnType<FetchUrlNodes> => ({
        ok: false,
        nodes: [],
        headers: {},
        error: "HTTP 525",
      })),
    });

    expect(result.failedSources).toHaveLength(1);
    expect(result.subscriptionInfo).toMatchObject({
      upload: 329579478,
      download: 4222002916,
      total: 64424509440,
      expire: 1796192081,
    });
  });

  it("每个源只累加一次，专用抓取覆盖同一源的主抓取记账", async () => {
    const fetchUrlNodes = vi.fn(async (source: Parameters<FetchUrlNodes>[0]): ReturnType<FetchUrlNodes> =>
      okNodes(source.id, { "subscription-userinfo": "upload=2048; download=4096; total=1048576" })
    );
    const fetchUrlUserInfo = vi.fn(async (_source: Parameters<FetchUrlUserInfo>[0]): ReturnType<FetchUrlUserInfo> => ({
      "subscription-userinfo": "upload=32768; download=65536; total=4194304",
    }));

    const result = await refreshNodeSnapshot({
      config: {
        sources: [
          { id: "url-a", type: "url", content: "https://a.example.com/sub" },
          {
            id: "url-b",
            type: "url",
            content: "https://b.example.com/sub",
            userinfoUserAgent: "clash.meta/1.19.24",
          },
        ],
      },
      urls: [],
      storedNodes: [],
      fetchUrlNodes,
      fetchUrlUserInfo,
    });

    expect(fetchUrlUserInfo).toHaveBeenCalledTimes(1);
    expect(result.subscriptionInfo).toMatchObject({
      upload: 2048 + 32768,
      download: 4096 + 65536,
      total: 1048576 + 4194304,
    });
  });
});
