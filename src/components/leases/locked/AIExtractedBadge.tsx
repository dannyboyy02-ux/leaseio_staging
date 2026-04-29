import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Sparkles } from 'lucide-react';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export function AIExtractedBadge() {
  const { t } = useAppTranslation();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="ml-2 gap-1 px-1.5 py-0 text-[10px] font-normal text-muted-foreground border-muted-foreground/30"
          >
            <Sparkles className="h-2.5 w-2.5" />
            {t('locked_lease.ai_extracted_badge')}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {t('locked_lease.ai_extracted_tooltip')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
