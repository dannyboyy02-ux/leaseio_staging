import { LandingNav } from '@/components/landing/LandingNav';
import { FooterSection } from '@/components/landing/FooterSection';

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <LandingNav />
      <main className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-4xl font-bold text-foreground mb-8">Privacy Policy</h1>
          
          <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-muted-foreground">
            <p className="text-lg">
              Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">1. Information We Collect</h2>
              <p>
                We collect information you provide directly to us, including your name, email address, 
                company name, and payment information when you register for an account or subscribe to our service.
              </p>
              <p>
                We also collect lease documents you upload to our platform for the purpose of providing 
                our AI-powered abstraction services.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">2. How We Use Your Information</h2>
              <p>We use the information we collect to:</p>
              <ul className="list-disc pl-6 space-y-2">
                <li>Provide, maintain, and improve our services</li>
                <li>Process your lease documents using AI technology</li>
                <li>Send you notifications about your leases and account</li>
                <li>Process payments and send invoices</li>
                <li>Respond to your comments, questions, and requests</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">3. Data Security</h2>
              <p>
                We implement appropriate technical and organizational measures to protect your personal 
                information and documents. All data is encrypted at rest using AES-256 encryption and 
                in transit using TLS 1.3.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">4. Data Retention</h2>
              <p>
                We retain your information for as long as your account is active or as needed to provide 
                you services. If you close your account, we will delete your data within 30 days unless 
                required by law to retain it longer.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">5. Your Rights</h2>
              <p>
                You have the right to access, correct, or delete your personal information at any time. 
                You can export your data through the application or by contacting support.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">6. Contact Us</h2>
              <p>
                If you have any questions about this Privacy Policy, please contact us at{' '}
                <a href="mailto:privacy@leaseio.com" className="text-primary hover:underline">
                  privacy@leaseio.com
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
