import type { TransportSessionSnapshot, UnifiedInboundEvent } from "../types/index.js";

export type RuntimeStore = {
  hasSeenInbound: (event: UnifiedInboundEvent) => boolean;
  markInboundSeen: (event: UnifiedInboundEvent) => boolean;
  readTransportSession: (accountId: string, transport: TransportSessionSnapshot["transport"]) => TransportSessionSnapshot | undefined;
  writeTransportSession: (snapshot: TransportSessionSnapshot) => void;
};
