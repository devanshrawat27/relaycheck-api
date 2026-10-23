import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_TARGETS,
  PublicTarget,
  TargetDefinition,
  isPrivateHost,
  normalizeTargetUrl,
} from './targets.types';

const DEMO_TARGET_NAME = 'demo-receiver';
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/i;

/**
 * Explicit, config-driven target registry. The API never accepts a URL from a
 * client: runs select a *name*, and only configured entries resolve.
 */
@Injectable()
export class TargetsService {
  private readonly logger = new Logger(TargetsService.name);

  private demoTarget(): TargetDefinition {
    const raw = process.env.DEMO_RECEIVER_URL ?? 'http://127.0.0.1:3100';
    return {
      name: DEMO_TARGET_NAME,
      url: normalizeTargetUrl(raw),
      kind: 'demo',
      allowPrivate: true,
      oracle: true,
    };
  }

  private remoteTargets(): TargetDefinition[] {
    const raw = process.env.TARGETS_JSON;
    if (!raw) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error('TARGETS_JSON is not valid JSON; remote targets disabled');
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.logger.error('TARGETS_JSON must be an array; remote targets disabled');
      return [];
    }

    const targets: TargetDefinition[] = [];
    for (const entry of parsed.slice(0, MAX_TARGETS)) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      const name = typeof candidate.name === 'string' ? candidate.name : '';
      const urlValue = typeof candidate.url === 'string' ? candidate.url : '';
      if (!NAME_PATTERN.test(name) || name === DEMO_TARGET_NAME) {
        this.logger.warn(`Skipping target with invalid/reserved name: ${name}`);
        continue;
      }
      let url: URL;
      try {
        url = new URL(urlValue);
      } catch {
        this.logger.warn(`Skipping target ${name}: invalid URL`);
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        this.logger.warn(`Skipping target ${name}: unsupported scheme`);
        continue;
      }
      const allowPrivate = candidate.allowPrivate === true;
      if (!allowPrivate && isPrivateHost(url.hostname)) {
        this.logger.error(
          `Refusing target ${name}: private/loopback host requires allowPrivate=true`,
        );
        continue;
      }
      targets.push({
        name,
        url: normalizeTargetUrl(urlValue),
        kind: 'remote',
        allowPrivate,
        oracle: candidate.oracle === true,
      });
    }
    return targets;
  }

  list(): TargetDefinition[] {
    return [this.demoTarget(), ...this.remoteTargets()];
  }

  /** Public (sanitized) view for the dashboard: names only, no URLs. */
  listPublic(): PublicTarget[] {
    return this.list().map((target) => ({
      name: target.name,
      kind: target.kind,
      oracle: target.oracle,
    }));
  }

  resolve(name: string): TargetDefinition | null {
    return this.list().find((target) => target.name === name) ?? null;
  }
}
