import { ReactNode, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  /** Optional subtitle / count badge content shown next to the title. */
  meta?: ReactNode;
  /** Right-aligned action slot — used by VendorCard for its Edit button. */
  action?: ReactNode;
  defaultOpen?: boolean;
  /** When false, renders a plain header (no toggle, no chevron) and always shows the body. */
  collapsible?: boolean;
  children: ReactNode;
}

export function SectionCard({
  title,
  meta,
  action,
  defaultOpen = true,
  collapsible = true,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  if (!collapsible) {
    return (
      <Card className="overflow-hidden border-border/60">
        <CardHeader className="flex flex-row items-center justify-between gap-4 py-4 px-5 bg-muted/20">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-sm font-semibold uppercase tracking-wide text-foreground">
              {title}
            </span>
            {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </CardHeader>
        <CardContent className="p-5 pt-4">{children}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden border-border/60">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="flex flex-row items-center justify-between gap-4 py-4 px-5 bg-muted/20">
          <div className="flex items-center gap-3 min-w-0">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 px-2 h-8 gap-2 font-semibold text-foreground hover:bg-transparent"
              >
                <ChevronDown
                  className={cn(
                    'h-4 w-4 text-muted-foreground transition-transform',
                    open ? 'rotate-0' : '-rotate-90'
                  )}
                />
                <span className="text-sm uppercase tracking-wide">{title}</span>
              </Button>
            </CollapsibleTrigger>
            {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="p-5 pt-4">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
