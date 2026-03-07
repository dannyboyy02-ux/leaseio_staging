import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Layers } from 'lucide-react';

export default function Portfolio() {
  return (
    <AppLayout>
      <AppHeader
        title="Portfolio"
        subtitle="Portfolio-level lease intelligence"
      />
      <div className="p-6">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Layers className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">
              Portfolio Intelligence
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Portfolio-level analytics, escalation monitoring, and renewal
              intelligence coming soon.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
