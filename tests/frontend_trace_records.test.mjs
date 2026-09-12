import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isSystemTraceEvent,
  traceCallRecords,
  traceRecordListFields,
  traceRecordKind,
  traceRecordName,
  traceRecordSearchText,
  traceRecordStatusLabel,
  traceValueSummary,
} from "../web/trace-record.js";

test("trace records summarize a search call without dumping raw JSON", () => {
  assert.equal(traceRecordName({
    node_type: "tool",
    name: "网络搜索工具",
  }), "网络搜索工具");
  assert.equal(traceRecordKind({ node_type: "tool" }), "工具调用");
  assert.equal(traceValueSummary({
    query: "福禄克万用表安全性",
    topic: "general",
    max_results: 8,
  }, "无入参"), "query: 福禄克万用表安全性 · topic: general · max_results: 8");
  assert.equal(traceValueSummary({
    results: [
      { title: "福禄克万用表产品页" },
      { title: "数字万用表安全须知" },
    ],
  }, "无返回值"), "找到 2 条结果：福禄克万用表产品页；数字万用表安全须知");
});

test("trace records label missing values and keep system events out of call records", () => {
  assert.equal(traceValueSummary(null, "无入参"), "无入参");
  assert.equal(traceValueSummary(undefined, "无返回值"), "无返回值");
  assert.equal(traceValueSummary({}, "无入参"), "无入参");
  assert.equal(traceValueSummary("", "无返回值"), "无返回值");
  assert.equal(isSystemTraceEvent({ event: "session_created" }), true);
  assert.equal(isSystemTraceEvent({ event: "message_sent" }), true);
  assert.equal(isSystemTraceEvent({ event: "tool_completed" }), false);
  assert.equal(traceRecordName({ node_type: "run" }), "本次任务");
  assert.equal(traceRecordKind({ node_type: "agent" }), "子助手");
});

test("trace call records retain only index fields and do not search hidden payloads", () => {
  const searchCall = {
    event: "tool_completed",
    node_type: "tool",
    name: "网络搜索工具",
    status: "completed",
    started_at: "2026-09-10T03:16:31.071Z",
    input: { query: "国产台式机参数" },
    output: { results: [{ title: "联想开天产品页" }] },
  };

  assert.deepEqual(
    traceCallRecords([
      { event: "session_created", node_type: "session" },
      searchCall,
      { event: "message_sent", node_type: "message" },
    ]),
    [searchCall],
  );
  assert.deepEqual(traceRecordListFields(searchCall), {
    name: "网络搜索工具",
    kind: "工具调用",
    status: "已完成",
    executedAt: "2026-09-10T03:16:31.071Z",
  });
  assert.match(traceRecordSearchText(searchCall), /网络搜索工具/);
  assert.match(traceRecordSearchText(searchCall), /工具调用/);
  assert.match(traceRecordSearchText(searchCall), /已完成/);
  assert.doesNotMatch(traceRecordSearchText(searchCall), /国产台式机参数/);
  assert.doesNotMatch(traceRecordSearchText(searchCall), /联想开天产品页/);
  assert.equal(traceRecordStatusLabel("running"), "执行中");
  assert.equal(traceRecordStatusLabel("completed"), "已完成");
  assert.equal(traceRecordStatusLabel("failed"), "失败");
});

test("call record renderer does not repeat input, output, or error details", () => {
  const appSource = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const renderEventsSource = appSource.slice(
    appSource.indexOf("function renderEvents"),
    appSource.indexOf("function renderReport"),
  );

  assert.match(renderEventsSource, /traceRecordListFields\(event\)/);
  assert.doesNotMatch(renderEventsSource, /call-record-details/);
  assert.doesNotMatch(renderEventsSource, /traceValueSummary\(event\.(input|output|error)/);
});
