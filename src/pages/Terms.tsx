import { LandingNav } from '@/components/landing/LandingNav';
import { FooterSection } from '@/components/landing/FooterSection';

export default function Terms() {
  return (
    <div className="min-h-screen bg-background">
      <LandingNav />
      <main className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-4xl font-bold text-foreground mb-8">Terms of Service</h1>
          
          <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-muted-foreground">
            <p className="text-lg">
              Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">1. Acceptance of Terms</h2>
              <p>
                By accessing or using LeaseAbstract Pro, you agree to be bound by these Terms of Service. 
                If you do not agree to these terms, you may not use our service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">2. Description of Service</h2>
              <p>
                LeaseAbstract Pro provides AI-powered lease abstraction and lease operations management 
                services. Our platform extracts key terms from lease documents, tracks important dates, 
                and integrates with accounting systems.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">3. User Accounts</h2>
              <p>
                You are responsible for maintaining the security of your account and password. 
                You must notify us immediately of any unauthorized access to your account.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">4. Subscription and Billing</h2>
              <p>
                Subscriptions are billed monthly in advance. Document limits are enforced per billing 
                period. Each master lease counts as one document, and each amendment counts as one 
                additional document.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">5. Data Ownership</h2>
              <p>
                You retain all rights to your lease documents and extracted data. We do not claim 
                ownership of any content you upload to our service. You may export your data at any time.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">6. Limitation of Liability</h2>
              <p>
                LeaseAbstract Pro is provided "as is" without warranties of any kind. We are not 
                liable for any errors in AI-extracted data. Users are responsible for reviewing 
                and verifying all extracted information before finalizing.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">7. Termination</h2>
              <p>
                You may cancel your subscription at any time. We may terminate your account for 
                violation of these terms. Upon termination, your data will be deleted within 30 days.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">8. Contact</h2>
              <p>
                For questions about these terms, contact us at{' '}
                <a href="mailto:legal@leaseabstract.pro" className="text-primary hover:underline">
                  legal@leaseabstract.pro
                </a>
              </p>
            </section>
          </div>
        </div>
      </main>
      <FooterSection />
    </div>
  );
}
