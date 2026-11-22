import type { Skill } from '@praxis/protocol';
import { type PageResult, type Registry, type RegistryEntry } from './api-transport';
import { ExtendedFeatureApiClient } from './api-x1';
export class FeatureApiClient extends ExtendedFeatureApiClient {
  async listSkills(): Promise<PageResult<Skill>> {
    return await this.request<PageResult<Skill>>('/v1/skills?limit=100');
  }

  async createSkill(input: {
    name: string;
    description: string;
    document: string;
    enabled?: boolean;
  }): Promise<Skill> {
    return await this.request<Skill>('/v1/skills', {
      method: 'POST',
      body: JSON.stringify({ type: 'skill.input', ...input }),
    });
  }

  async patchSkill(
    skillId: string,
    input: {
      name: string;
      description: string;
      document: string;
      enabled?: boolean;
    },
  ): Promise<Skill> {
    return await this.request<Skill>(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'skill.input', ...input }),
    });
  }

  async deleteSkill(skillId: string): Promise<{ type: 'ok' }> {
    return await this.request<{ type: 'ok' }>(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
    });
  }

  async listSkillRegistries(): Promise<PageResult<Registry>> {
    return await this.request<PageResult<Registry>>('/v1/skill-registries?limit=100');
  }

  async createSkillRegistry(input: {
    name: string;
    url: string;
    enabled?: boolean;
  }): Promise<Registry> {
    return await this.request<Registry>('/v1/skill-registries', {
      method: 'POST',
      body: JSON.stringify({ type: 'skill.registry.input', ...input }),
    });
  }

  async deleteSkillRegistry(registryId: string): Promise<{ type: 'ok' }> {
    return await this.request<{ type: 'ok' }>(
      `/v1/skill-registries/${encodeURIComponent(registryId)}`,
      { method: 'DELETE' },
    );
  }

  async searchSkillRegistry(registryId: string, q = ''): Promise<PageResult<RegistryEntry>> {
    return await this.request<PageResult<RegistryEntry>>(
      `/v1/skill-registries/${encodeURIComponent(registryId)}/search?q=${encodeURIComponent(q)}`,
    );
  }

  async installRegistrySkill(registryId: string, skillId: string): Promise<Skill> {
    return await this.request<Skill>(
      `/v1/skill-registries/${encodeURIComponent(registryId)}/install`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'skill.install', skillId }),
      },
    );
  }
}
