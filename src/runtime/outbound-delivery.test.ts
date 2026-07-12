import { beforeEach, describe, expect, it } from "vitest";
import {
  clearWecomOutboundDeliveriesForTest,
  getWecomOutboundDeliverySequence,
  recordWecomOutboundDelivery,
} from "./outbound-delivery.js";

describe("WeCom outbound delivery sequence", () => {
  beforeEach(clearWecomOutboundDeliveriesForTest);

  it("advances independently per session", () => {
    recordWecomOutboundDelivery("session-a");
    const firstA = getWecomOutboundDeliverySequence("session-a");
    recordWecomOutboundDelivery("session-b");
    recordWecomOutboundDelivery("session-a");
    expect(getWecomOutboundDeliverySequence("session-a")).toBeGreaterThan(firstA);
    expect(getWecomOutboundDeliverySequence("session-b")).toBeGreaterThan(0);
  });
});
