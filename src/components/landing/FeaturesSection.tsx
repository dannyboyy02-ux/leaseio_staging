import { 
  FileSearch, 
  Bell, 
  TrendingUp, 
  FileSpreadsheet,
  Calendar,
  Shield 
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

const features = [
  {
    icon: FileSearch,
    title: 'AI Lease Extraction',
    description: 'Upload a PDF and our AI extracts key terms, dates, parties, and rent schedules in minutes—not hours.',
  },
  {
    icon: Calendar,
    title: 'Deadline Tracking',
    description: 'Never miss a renewal window or expiration date. Visual calendar shows what\'s coming up across your portfolio.',
  },
  {
    icon: TrendingUp,
    title: 'Rent Schedule Management',
    description: 'Track escalations, step increases, and rent changes. Know exactly what you owe each month.',
  },
  {
    icon: Bell,
    title: 'Smart Notifications',
    description: 'Get email alerts for renewals, expirations, and payment due dates. Customize timing to match your workflow.',
  },
  {
    icon: FileSpreadsheet,
    title: 'One-Click Rent Roll',
    description: 'Export your entire portfolio to CSV with one click. Total monthly rent, annual obligations, and more.',
  },
  {
    icon: Shield,
    title: 'Secure & Private',
    description: 'Bank-grade encryption keeps your lease documents safe. Your data is never shared or used for training.',
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Built for operators, not accountants
          </h2>
          <p className="text-lg text-muted-foreground">
            No complex accounting standards. No journal entries. Just simple, clear visibility 
            into your lease obligations.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature) => (
            <Card key={feature.title} className="relative overflow-hidden group hover:shadow-lg transition-shadow">
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