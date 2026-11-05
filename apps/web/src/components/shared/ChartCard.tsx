import type * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer } from '@/components/ui/chart';
import { cn } from '@/lib/utils';

export type ChartCardProps = {
  title: string;
  description?: string;
  config: ChartConfig;
  children: React.ComponentProps<typeof ChartContainer>['children'];
  surface?: 'solid' | 'glass';
  className?: string;
  bodyClassName?: string;
};

export function ChartCard({
  title,
  description,
  config,
  children,
  surface = 'solid',
  className,
  bodyClassName,
}: ChartCardProps) {
  return (
    <Card surface={surface} className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className={cn('h-64 w-full', bodyClassName)}>
          {children}
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
