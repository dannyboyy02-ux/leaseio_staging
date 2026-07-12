import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Loader2, AlertCircle } from 'lucide-react';
import {
  FinancialImpactSummary,
  type SummaryData,
} from '@/components/summary/FinancialImpactSummary';
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/hooks/useAppTranslation';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string;

export default function PublicSummaryPage() {
  const { t } = useAppTranslation();
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!token) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    const fnUrl = `${SUPABASE_URL}/functions/v1/get-summary-by-token?token=${encodeURIComponent(token)}`;
    fetch(fnUrl, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
    })
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const json = await res.json();
        setData(json as SummaryData);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [token]);

  const handlePrint = () => window.print();

  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">{t('public_summary.loading')}</span>
        </div>
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-sm px-4">
          <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-gray-900 mb-2">{t('public_summary.not_found_title')}</h1>
          <p className="text-muted-foreground text-sm">
            {t('public_summary.not_found_desc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toolbar — hidden on print */}
      <div className="no-print sticky top-0 z-10 bg-white border-b px-6 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-blue-700">LeaseIO</span>
          <span className="text-muted-foreground text-sm hidden sm:block">
            {t('public_summary.title')}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={handlePrint}>
          <Download className="h-4 w-4 mr-2" />
          {t('public_summary.download_pdf')}
        </Button>
      </div>

      {/* Summary */}
      <div className="py-8 px-4">
        <div className="max-w-3xl mx-auto bg-white shadow-lg rounded-xl overflow-hidden print:shadow-none print:rounded-none print:max-w-none">
          <FinancialImpactSummary data={data} shareUrl={shareUrl} />
        </div>
      </div>
    </div>
  );
}
