'use client';

import type * as React from 'react';
import { cn } from '@/lib/utils';

type TooltipProps = {
  content: string;
  children: React.ReactNode;
  className?: string;
};

export function Tooltip({ content, children, className }: TooltipProps) {
  return (
    <span className={cn('group/tooltip relative inline-flex min-w-0', className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 bottom-full -translate-x-1/2 mb-2 hidden max-w-xs rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg group-hover/tooltip:block z-50 whitespace-normal break-words"
      >
        {content}
      </span>
    </span>
  );
}
