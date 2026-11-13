import React from 'react';
import { bindIcon } from '@praxis/glass';
import { ArrowUpRight } from 'lucide-react';
import { Globe, Link } from '../../lib/icons';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../ui/trace';
import type { TraceSource } from './toolSources';
import styles from './Activity.module.css';

const ArrowUpRightIcon = bindIcon(ArrowUpRight);

export function SourcesTrace({ sources }: { sources: TraceSource[] }) {
  if (sources.length === 0) return null;
  const label = `Used ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`;

  return (
    <Trace data-testid="turn-sources-trace">
      <TraceCollapsible>
        <TraceCollapsibleTrigger data-testid="turn-sources-toggle">
          <TraceLine>
            <TraceIcon>
              <Link size={16} />
            </TraceIcon>
            <TraceTitle>{label}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted={false}>
          <Trace>
            {sources.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                data-testid="turn-source-link"
              >
                <TraceLine>
                  <TraceIcon>
                    <Globe size={16} />
                  </TraceIcon>
                  <TraceTitle>
                    {source.title}
                    <span className={styles.srOnly}> (opens in a new tab)</span>
                  </TraceTitle>
                  {source.domain ? <TraceDescription>{source.domain}</TraceDescription> : null}
                  <TraceIcon>
                    <ArrowUpRightIcon size={16} />
                  </TraceIcon>
                </TraceLine>
              </a>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
