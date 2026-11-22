// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollWorkAreaChanges, WORK_AREA_POLL_MS, workAreaKey } from "./workAreaPoll";

const area = (right: number, bottom = 1000) => ({ left: 0, top: 0, right, bottom });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keys a work area by all four edges", () => {
  expect(workAreaKey({ left: -1920, top: 24, right: 0, bottom: 1040 })).toBe("-1920:24:0:1040");
});

it("reports only a change from the previous read, never the first read", async () => {
  const onChange = vi.fn();
  const readArea = vi.fn(async () => area(1920));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => false });
  await vi.advanceTimersByTimeAsync(0);
  expect(readArea).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 2);
  expect(readArea).toHaveBeenCalledTimes(3);
  expect(onChange).not.toHaveBeenCalled();
  readArea.mockResolvedValue(area(1880));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
  // The same new area again is not another change.
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  expect(onChange).toHaveBeenCalledTimes(1);
  stop();
  readArea.mockResolvedValue(area(1280));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(readArea).toHaveBeenCalledTimes(7);
});

it("skips reads while hidden or while a read is still pending, and ignores a read that ends after stop", async () => {
  const onChange = vi.fn();
  let hidden = true;
  let finish: ((value: ReturnType<typeof area>) => void) | undefined;
  const readArea = vi.fn(() => new Promise<ReturnType<typeof area>>(resolve => { finish = resolve; }));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => hidden });
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(readArea).not.toHaveBeenCalled();
  hidden = false;
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS * 3);
  // The first read never resolved, so no second read started.
  expect(readArea).toHaveBeenCalledTimes(1);
  finish!(area(1920));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(readArea).toHaveBeenCalledTimes(2);
  stop();
  finish!(area(1280));
  await vi.advanceTimersByTimeAsync(0);
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps polling after a failed read", async () => {
  const onChange = vi.fn();
  const readArea = vi.fn(async () => area(1920));
  readArea.mockRejectedValueOnce(new Error("no monitor"));
  const stop = pollWorkAreaChanges(onChange, readArea, { isHidden: () => false });
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  readArea.mockResolvedValue(area(1500));
  await vi.advanceTimersByTimeAsync(WORK_AREA_POLL_MS);
  expect(onChange).toHaveBeenCalledTimes(1);
  stop();
});
