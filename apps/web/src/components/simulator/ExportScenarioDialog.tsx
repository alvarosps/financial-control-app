'use client';

import type { SimScenario } from '@fc/shared';
import { Copy, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { copyText } from '@/lib/clipboard';
import { buildExport } from '@/lib/simulator/build-export';
import type { RunResult } from '@/lib/simulator/export-types';
import { downloadText } from './export/copy-download';

type ExportScenarioDialogProps = {
  run: RunResult;
  scenario: SimScenario;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type TabKey = 'markdown' | 'json' | 'prompt';

const TAB_META: Record<TabKey, { ext: string; mime: string }> = {
  markdown: { ext: 'md', mime: 'text/markdown' },
  json: { ext: 'json', mime: 'application/json' },
  prompt: { ext: 'txt', mime: 'text/plain' },
};

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'scenario'
  );
}

export function ExportScenarioDialog({
  run,
  scenario,
  open,
  onOpenChange,
}: ExportScenarioDialogProps) {
  const t = useTranslations();
  const [tab, setTab] = useState<TabKey>('markdown');
  const [question, setQuestion] = useState('');

  // The parent passes a fresh `scenario` object each render, so a useMemo here
  // would never hold; buildExport is cheap, so call it directly.
  const artifacts = buildExport(run, scenario, question.trim() ? question.trim() : undefined);

  const content: Record<TabKey, string> = {
    markdown: artifacts.markdown,
    json: artifacts.json,
    prompt: artifacts.prompt,
  };

  const handleCopy = async () => {
    try {
      await copyText(content[tab]);
      toast.success(t('simulator.export.copied'));
    } catch {
      toast.error(t('simulator.export.copyFailed'));
    }
  };

  const handleDownload = () => {
    try {
      const meta = TAB_META[tab];
      downloadText(content[tab], `${slugify(scenario.name)}.${meta.ext}`, meta.mime);
      toast.success(t('simulator.export.downloaded'));
    } catch {
      toast.error(t('simulator.export.downloadFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('simulator.export.title')}</DialogTitle>
          <DialogDescription>{t('simulator.export.description')}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList>
            <TabsTrigger value="markdown">{t('simulator.export.tabMarkdown')}</TabsTrigger>
            <TabsTrigger value="json">{t('simulator.export.tabJson')}</TabsTrigger>
            <TabsTrigger value="prompt">{t('simulator.export.tabPrompt')}</TabsTrigger>
          </TabsList>

          {(['markdown', 'json', 'prompt'] as const).map((key) => (
            <TabsContent key={key} value={key} className="space-y-3">
              {key === 'prompt' && (
                <div className="space-y-1.5">
                  <label htmlFor="sim-export-question" className="text-xs text-muted-foreground">
                    {t('simulator.export.questionLabel')}
                  </label>
                  <Textarea
                    id="sim-export-question"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={t('simulator.export.questionPlaceholder')}
                    rows={2}
                  />
                </div>
              )}
              <Textarea
                readOnly
                value={content[key]}
                className="h-72 font-mono text-xs"
                aria-label={t('simulator.export.contentAria')}
              />
            </TabsContent>
          ))}
        </Tabs>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <Copy className="size-3.5" />
            {t('simulator.export.copy')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="size-3.5" />
            {t('simulator.export.download')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
