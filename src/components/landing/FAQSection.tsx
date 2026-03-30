import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useLanguage } from '@/contexts/LanguageContext';

export function FAQSection() {
  const { t } = useLanguage();

  const faqKeys = [
    'document_count',
    'ai_extraction',
    'edit_data',
    'document_limit',
    'data_ownership',
    'security',
    'multiple_users',
  ];

  return (
    <section id="faq" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            {t('landing.faq.title')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('landing.faq.subtitle')}
          </p>
        </div>

        <Accordion type="single" collapsible className="space-y-4">
          {faqKeys.map((key, index) => (
            <AccordionItem 
              key={key} 
              value={`faq-${index}`}
              className="bg-card border border-border rounded-lg px-6"
            >
              <AccordionTrigger className="text-left font-medium text-foreground hover:no-underline">
                {t(`landing.faq.${key}.q`)}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground">
                {t(`landing.faq.${key}.a`)}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
