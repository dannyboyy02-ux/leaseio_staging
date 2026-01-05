import { 
  FileSearch, 
  Bell, 
  TrendingUp, 
  Link as LinkIcon, 
  Shield, 
  FileSpreadsheet 
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

const features = [
  {
    icon: FileSearch,
    title: 'AI Lease Abstraction',
    description: 'Upload a PDF and our AI extracts key terms, dates, parties, and rent schedules—with human review for accuracy.',
  },
  {
    icon: Bell,
    title: 'Smart Notifications',
    description: 'Never miss a renewal window or escalation date. Get email and SMS alerts exactly when you need them.',
  },
  {
    icon: TrendingUp,
    title: 'Escalation Tracking',
    description: 'Automatically track fixed, step, and CPI-based rent escalations with clear visibility into future obligations.',
  },
  {
    icon: FileSpreadsheet,
    title: 'Rent Roll & Reports',
    description: 'Generate comprehensive rent rolls and portfolio reports. Export to CSV/Excel for your workflows.',
    businessOnly: true,
  },
  {
    icon: LinkIcon,
    title: 'QuickBooks Sync',
    description: 'Connect to QuickBooks Online and automate your lease accounting. Invoices and bills created automatically.',
    businessOnly: true,
  },
  {
    icon: Shield,
    title: 'Audit & Security',
    description: 'Full audit trail of all changes. Bank-grade encryption and role-based access controls keep your data safe.',
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Everything you need to manage leases
          </h2>
          <p className="text-lg text-muted-foreground">
            From extraction to accounting, LeaseAbstract Pro handles the entire lease lifecycle.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature) => (
            <Card key={feature.title} className="relative overflow-hidden group hover:shadow-lg transition-shadow">
              {feature.businessOnly && (
                <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs font-medium">
                  Business
                </div>
              )}
              <CardContent className="p-6">
                <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                  <feature.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold text-lg text-foreground mb-2">{feature.title}</h3>
                <p className="text-muted-foreground text-sm">{feature.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
