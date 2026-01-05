import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { 
  ArrowLeft, 
  FileText, 
  CheckCircle, 
  AlertTriangle, 
  AlertCircle,
  Calendar,
  Building2,
  DollarSign,
  User,
  Download,
  Edit,
  Loader2
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface LeaseData {
  id: string;
  filename: string;
  status: string;
  landlord_name: string | null;
  tenant_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  base_rent_amount: string | null;
  base_rent_frequency: string | null;
  extracted_json: {
    property_address?: string;
    security_deposit?: string;
    renewal_options?: string;
    escalation_clauses?: string;
    termination_clauses?: string;
    key_dates?: { date: string; description: string }[];
  } | null;
  uploaded_at: string;
  processed_at: string | null;
}

interface Risk {
  id: string;
  title: string;
  severity: string;
  explanation: string | null;
  citation_snippet: string | null;
  citation_page: number | null;
}

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const [lease, setLease] = useState<LeaseData | null>(null);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchLease() {
      if (!leaseId) return;

      try {
        const { data: leaseData, error: leaseError } = await supabase
          .from('leases')
          .select('*')
          .eq('id', leaseId)
          .single();

        if (leaseError) throw leaseError;
        
        // Type assertion for extracted_json since Supabase returns Json type
        const typedLease: LeaseData = {
          ...leaseData,
          extracted_json: leaseData.extracted_json as LeaseData['extracted_json']
        };
        setLease(typedLease);

        const { data: risksData, error: risksError } = await supabase
          .from('risks')
          .select('*')
          .eq('lease_id', leaseId);

        if (risksError) throw risksError;
        setRisks(risksData || []);
      } catch (error) {
        console.error('Error fetching lease:', error);
        toast.error('Failed to load lease');
      } finally {
        setLoading(false);
      }
    }

    fetchLease();
  }, [leaseId]);

  const handleFinalize = async () => {
    if (!lease) return;

    try {
      const { error } = await supabase
        .from('leases')
        .update({ status: 'final' })
        .eq('id', lease.id);

      if (error) throw error;

      setLease({ ...lease, status: 'final' });
      toast.success('Lease finalized successfully');
    } catch (error) {
      console.error('Error finalizing lease:', error);
      toast.error('Failed to finalize lease');
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high':
        return 'bg-destructive/10 text-destructive border-destructive/20';
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'low':
        return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'high':
        return <AlertCircle className="h-4 w-4" />;
      case 'medium':
        return <AlertTriangle className="h-4 w-4" />;
      default:
        return <AlertTriangle className="h-4 w-4" />;
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!lease) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
          <FileText className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">Lease not found</p>
          <Button variant="outline" onClick={() => navigate('/app/leases')}>
            Back to Leases
          </Button>
        </div>
      </AppLayout>
    );
  }

  const extractedData = lease.extracted_json || {};

  return (
    <AppLayout>
      <AppHeader
        title="Review Lease"
        subtitle={lease.filename}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate('/app/leases')}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            {lease.status === 'review' && (
              <Button variant="accent" onClick={handleFinalize}>
                <CheckCircle className="h-4 w-4 mr-2" />
                Finalize Lease
              </Button>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Status Banner */}
        {lease.status === 'review' && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div>
              <p className="font-medium text-yellow-600">Review Required</p>
              <p className="text-sm text-muted-foreground">
                Please review the extracted information below and make any necessary corrections before finalizing.
              </p>
            </div>
          </div>
        )}

        {lease.status === 'final' && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-start gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
            <div>
              <p className="font-medium text-green-600">Finalized</p>
              <p className="text-sm text-muted-foreground">
                This lease has been reviewed and finalized.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Parties */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Parties
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Landlord</p>
                  <p className="font-medium">{lease.landlord_name || 'Not extracted'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Tenant</p>
                  <p className="font-medium">{lease.tenant_name || 'Not extracted'}</p>
                </div>
              </CardContent>
            </Card>

            {/* Property & Dates */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Property & Term
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Property Address</p>
                  <p className="font-medium">{extractedData.property_address || 'Not extracted'}</p>
                </div>
                <Separator />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex items-center gap-3">
                    <Calendar className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Commencement Date</p>
                      <p className="font-medium">
                        {lease.lease_start 
                          ? format(new Date(lease.lease_start), 'MMM d, yyyy')
                          : 'Not extracted'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Calendar className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-muted-foreground">Expiration Date</p>
                      <p className="font-medium">
                        {lease.lease_end 
                          ? format(new Date(lease.lease_end), 'MMM d, yyyy')
                          : 'Not extracted'}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Financial Terms */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Financial Terms
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Base Rent</p>
                  <p className="font-medium text-lg">
                    {lease.base_rent_amount || 'Not extracted'}
                    {lease.base_rent_frequency && (
                      <span className="text-sm text-muted-foreground ml-1">
                        / {lease.base_rent_frequency}
                      </span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Security Deposit</p>
                  <p className="font-medium">{extractedData.security_deposit || 'Not extracted'}</p>
                </div>
                {extractedData.escalation_clauses && (
                  <div className="sm:col-span-2">
                    <p className="text-sm text-muted-foreground">Escalation Clauses</p>
                    <p className="text-sm">{extractedData.escalation_clauses}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Additional Terms */}
            {(extractedData.renewal_options || extractedData.termination_clauses) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Additional Terms</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {extractedData.renewal_options && (
                    <div>
                      <p className="text-sm text-muted-foreground">Renewal Options</p>
                      <p className="text-sm">{extractedData.renewal_options}</p>
                    </div>
                  )}
                  {extractedData.termination_clauses && (
                    <div>
                      <p className="text-sm text-muted-foreground">Termination Clauses</p>
                      <p className="text-sm">{extractedData.termination_clauses}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Key Dates */}
            {extractedData.key_dates && extractedData.key_dates.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Key Dates</CardTitle>
                  <CardDescription>Important dates extracted from the lease</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {extractedData.key_dates.map((item, index) => (
                      <div key={index} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="font-medium text-sm">{item.date}</p>
                          <p className="text-sm text-muted-foreground">{item.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Document Info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Document</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <FileText className="h-8 w-8 text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{lease.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      Uploaded {format(new Date(lease.uploaded_at), 'MMM d, yyyy')}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1">
                    <Download className="h-4 w-4 mr-1" />
                    Download
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1">
                    <Edit className="h-4 w-4 mr-1" />
                    Edit
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Risks */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center justify-between">
                  <span>Identified Risks</span>
                  <Badge variant="outline">{risks.length}</Badge>
                </CardTitle>
                <CardDescription>
                  AI-identified potential issues in this lease
                </CardDescription>
              </CardHeader>
              <CardContent>
                {risks.length === 0 ? (
                  <div className="text-center py-6">
                    <CheckCircle className="h-8 w-8 text-green-500 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No risks identified</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {risks.map((risk) => (
                      <div
                        key={risk.id}
                        className={cn(
                          'p-3 rounded-lg border',
                          getSeverityColor(risk.severity)
                        )}
                      >
                        <div className="flex items-start gap-2">
                          {getSeverityIcon(risk.severity)}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{risk.title}</p>
                            {risk.explanation && (
                              <p className="text-xs mt-1 opacity-80">{risk.explanation}</p>
                            )}
                            {risk.citation_page && (
                              <p className="text-xs mt-1 opacity-60">
                                Page {risk.citation_page}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Status */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Status</CardTitle>
              </CardHeader>
              <CardContent>
                <Badge
                  variant={lease.status === 'final' ? 'default' : 'secondary'}
                  className="capitalize"
                >
                  {lease.status}
                </Badge>
                {lease.processed_at && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Processed {format(new Date(lease.processed_at), 'MMM d, yyyy h:mm a')}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
