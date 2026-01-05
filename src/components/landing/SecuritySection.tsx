import { Shield, Lock, Eye, Server } from 'lucide-react';

const securityFeatures = [
  {
    icon: Lock,
    title: 'End-to-end encryption',
    description: 'Your documents are encrypted at rest and in transit using AES-256.',
  },
  {
    icon: Shield,
    title: 'Role-based access',
    description: 'Control who can view, edit, or manage leases with granular permissions.',
  },
  {
    icon: Eye,
    title: 'Audit logging',
    description: 'Every action is logged for compliance and accountability.',
  },
  {
    icon: Server,
    title: 'SOC 2 compliant hosting',
    description: 'Hosted on enterprise-grade infrastructure with 99.9% uptime.',
  },
];

export function SecuritySection() {
  return (
    <section id="security" className="py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
              Enterprise-grade security
            </h2>
            <p className="text-lg text-muted-foreground mb-8">
              Your lease documents contain sensitive business information. 
              We treat security as a first-class concern, not an afterthought.
            </p>

            <div className="space-y-6">
              {securityFeatures.map((feature) => (
                <div key={feature.title} className="flex items-start gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground">{feature.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="aspect-square bg-gradient-to-br from-primary/20 to-accent/20 rounded-3xl flex items-center justify-center">
              <div className="h-32 w-32 rounded-full bg-primary/10 flex items-center justify-center">
                <Shield className="h-16 w-16 text-primary" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
