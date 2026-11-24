// Join of ground truth with the monitor's events by path (contracts/monitor.md, The headline join).
// P2 stub (contracts/api.md). Lane P3c replaces the bodies; the signatures are the contract.

export function matchWrites(truthRecords, monitorEvents, { matcher = "contract", rawEvents = [] } = {}) {
  throw new Error("HB not implemented: score.matchWrites");
}

export function matchEgress(connectRecords, rawEvents) {
  throw new Error("HB not implemented: score.matchEgress");
}
