import type { JsonStore } from "../store.js";
import type { GatewayAuditEvent } from "./contracts.js";

export interface AuditWriter {
  append(event: GatewayAuditEvent): Promise<void>;
  appendBatch(events: readonly GatewayAuditEvent[]): Promise<void>;
}

export class PersistentAuditLog implements AuditWriter {
  constructor(private readonly store: JsonStore) {}

  async append(event: GatewayAuditEvent): Promise<void> {
    await this.appendBatch([event]);
  }

  async appendBatch(events: readonly GatewayAuditEvent[]): Promise<void> {
    await this.store.mutate((database) => {
      database.gatewayAuditEvents.push(...structuredClone(events));
    });
  }

  listForAgent(agentPrincipalId: string): GatewayAuditEvent[] {
    return this.store
      .snapshot()
      .gatewayAuditEvents.filter(
        (event) => event.agentPrincipalId === agentPrincipalId,
      )
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  async clearForAgent(agentPrincipalId: string): Promise<void> {
    await this.store.mutate((database) => {
      database.gatewayAuditEvents = database.gatewayAuditEvents.filter(
        (event) => event.agentPrincipalId !== agentPrincipalId,
      );
    });
  }
}
