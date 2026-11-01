import type { Connector, Skill } from '@praxis/protocol';
import { ApiTransport, type PageResult } from './api-transport';
export interface SkillUpdate {
  type: 'skill.update';
  skillId: string;
  registryId: string;
  entryId: string;
  digest: string;
  updateAvailable: true;
}
export interface ConnectorCandidate {
  type: 'connector.registry.entry';
  id: string;
  description: string;
  input: { name: string; url: string; transport?: Connector['transport']; enabled?: boolean };
  headerNames: string[];
  requiresConfiguration: boolean;
}
export class ExtendedFeatureApiClient extends ApiTransport {
  listSkillUpdates() {
    return this.request<PageResult<SkillUpdate>>('/v1/skills/updates');
  }
  updateRegistrySkill(id: string) {
    return this.request<Skill>(`/v1/skills/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: '{}',
    });
  }
  importSkillArchive(attachmentId: string) {
    return this.request<{ type: 'skill.import.result'; skill: Skill; dropped: string[] }>(
      '/v1/skills/import',
      { method: 'POST', body: JSON.stringify({ type: 'skill.import', attachmentId }) },
    );
  }
  searchConnectorRegistry(q = '', cursor?: string) {
    const query = new URLSearchParams({ q, ...(cursor ? { cursor } : {}) });
    return this.request<PageResult<ConnectorCandidate>>(`/v1/connectors/registry?${query}`);
  }
}
