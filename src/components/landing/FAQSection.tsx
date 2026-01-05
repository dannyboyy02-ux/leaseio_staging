import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const faqs = [
  {
    question: 'What counts as a document?',
    answer: 'Each master lease counts as one document. Each amendment to a lease also counts as one document. So a master lease with two amendments would use 3 of your document limit.',
  },
  {
    question: 'How does the AI extraction work?',
    answer: 'Our AI reads your PDF lease document and extracts key information like parties, dates, rent amounts, escalation schedules, and important clauses. You then review and confirm the extracted data before finalizing.',
  },
  {
    question: 'Can I edit the extracted data?',
    answer: 'Absolutely. After AI extraction, you review everything in a side-by-side view with the original PDF. You can edit any field before finalizing the lease abstract.',
  },
  {
    question: 'What happens if I hit my document limit?',
    answer: 'You won\'t be able to upload new documents until you upgrade your plan or your billing period resets. Existing documents remain fully accessible.',
  },
  {
    question: 'How does QuickBooks integration work?',
    answer: 'Available on the Business plan, you connect your QuickBooks Online account via OAuth. Choose whether you\'re a lessor (creates invoices) or lessee (creates bills), match vendors/customers, and we\'ll automatically create transactions based on your rent schedule.',
  },
  {
    question: 'Who owns my data?',
    answer: 'You do. Your documents and extracted data belong to you. You can export everything at any time, and if you close your account, we delete your data within 30 days.',
  },
  {
    question: 'Is my data secure?',
    answer: 'Yes. We use AES-256 encryption for data at rest and TLS 1.3 for data in transit. Our infrastructure is SOC 2 compliant, and we support role-based access controls within your workspace.',
  },
  {
    question: 'Can I have multiple users in my workspace?',
    answer: 'Yes. You can invite team members with different roles: Owner, Admin, Manager, Reviewer, or Read-only. Each role has specific permissions for billing, integrations, and lease management.',
  },
];

export function FAQSection() {
  return (
    <section id="faq" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Frequently asked questions
          </h2>
          <p className="text-lg text-muted-foreground">
            Everything you need to know about LeaseAbstract Pro.
          </p>
        </div>

        <Accordion type="single" collapsible className="space-y-4">
          {faqs.map((faq, index) => (
            <AccordionItem 
              key={index} 
              value={`faq-${index}`}
              className="bg-card border border-border rounded-lg px-6"
            >
              <AccordionTrigger className="text-left font-medium text-foreground hover:no-underline">
                {faq.question}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground">
                {faq.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
