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
  Save,
  Loader2
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface ExtractedJson {
  property_address?: string;
  security_deposit?: string;
  renewal_options?: string;
  escalation_clauses?: string;
  termination_clauses?: string;
  key_dates?: { date: string; description: string }[];
}

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
  extracted_json: ExtractedJson | null;
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

interface EditableFields {
  landlord_name: string;
  tenant_name: string;
  property_address: string;
  lease_start: string;
  lease_end: string;
  base_rent_amount: string;
  base_rent_frequency: string;
  security_deposit: string;
  renewal_options: string;
  escalation_clauses: string;
  termination_clauses: string;
}

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const [lease, setLease] = useState<LeaseData | null>(null);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editableFields, setEditableFields] = useState<EditableFields>({
    landlord_name: '',
    tenant_name: '',
    property_address: '',
    lease_start: '',
    lease_end: '',
    base_rent_amount: '',
    base_rent_frequency: '',
    security_deposit: '',
    renewal_options: '',
    escalation_clauses: '',
    termination_clauses: '',
  });

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
        
        const typedLease: LeaseData = {
          ...leaseData,
          extracted_json: leaseData.extracted_json as ExtractedJson | null
        };
        setLease(typedLease);

        // Populate editable fields
        const extracted = typedLease.extracted_json || {};
        setEditableFields({
          landlord_name: typedLease.landlord_name || '',
          tenant_name: typedLease.tenant_name || '',
          property_address: extracted.property_address || '',
          lease_start: typedLease.lease_start || '',
          lease_end: typedLease.lease_end || '',
          base_rent_amount: typedLease.base_rent_amount || '',
          base_rent_frequency: typedLease.base_rent_frequency || '',
          security_deposit: extracted.security_deposit || '',
          renewal_options: extracted.renewal_options || '',
          escalation_clauses: extracted.escalation_clauses || '',
          termination_clauses: extracted.termination_clauses || '',
        });

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

  const handleFieldChange = (field: keyof EditableFields, value: string) => {
    setEditableFields(prev => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!lease) return;

    setSaving(true);
    try {
      const updatedExtractedJson: ExtractedJson = {
        ...(lease.extracted_json || {}),
        property_address: editableFields.property_address || undefined,
        security_deposit: editableFields.security_deposit || undefined,
        renewal_options: editableFields.renewal_options || undefined,
        escalation_clauses: editableFields.escalation_clauses || undefined,
        termination_clauses: editableFields.termination_clauses || undefined,
      };

      const { error } = await supabase
        .from('leases')
        .update({
          landlord_name: editableFields.landlord_name || null,
          tenant_name: editableFields.tenant_name || null,
          lease_start: editableFields.lease_start || null,
          lease_end: editableFields.lease_end || null,
          base_rent_amount: editableFields.base_rent_amount || null,
          base_rent_frequency: editableFields.base_rent_frequency || null,
          extracted_json: JSON.parse(JSON.stringify(updatedExtractedJson)),
        })
        .eq('id', lease.id);

      if (error) throw error;

      setLease({
        ...lease,
        landlord_name: editableFields.landlord_name || null,
        tenant_name: editableFields.tenant_name || null,
        lease_start: editableFields.lease_start || null,
        lease_end: editableFields.lease_end || null,
        base_rent_amount: editableFields.base_rent_amount || null,
        base_rent_frequency: editableFields.base_rent_frequency || null,
        extracted_json: updatedExtractedJson,
      });

      toast.success('Lease saved successfully');
    } catch (error) {
      console.error('Error saving lease:', error);
      toast.error('Failed to save lease');
    } finally {
      setSaving(false);
    }
  };

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

  const keyDates = lease.extracted_json?.key_dates || [];

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
            <Button variant="outline" onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save
            </Button>
            {lease.status === 'review' && (
              <Button variant="accent" onClick={handleFinalize}>
                <CheckCircle className="h-4 w-4 mr-2" />
                Finalize
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
                Review and edit the extracted information below, then save your changes before finalizing.
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
                <div className="space-y-2">
                  <Label htmlFor="landlord_name">Landlord</Label>
                  <Input
                    id="landlord_name"
                    value={editableFields.landlord_name}
                    onChange={(e) => handleFieldChange('landlord_name', e.target.value)}
                    placeholder="Landlord name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tenant_name">Tenant</Label>
                  <Input
                    id="tenant_name"
                    value={editableFields.tenant_name}
                    onChange={(e) => handleFieldChange('tenant_name', e.target.value)}
                    placeholder="Tenant name"
                  />
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
                <div className="space-y-2">
                  <Label htmlFor="property_address">Property Address</Label>
                  <Input
                    id="property_address"
                    value={editableFields.property_address}
                    onChange={(e) => handleFieldChange('property_address', e.target.value)}
                    placeholder="Full property address"
                  />
                </div>
                <Separator />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="lease_start" className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      Commencement Date
                    </Label>
                    <Input
                      id="lease_start"
                      type="date"
                      value={editableFields.lease_start}
                      onChange={(e) => handleFieldChange('lease_start', e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lease_end" className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      Expiration Date
                    </Label>
                    <Input
                      id="lease_end"
                      type="date"
                      value={editableFields.lease_end}
                      onChange={(e) => handleFieldChange('lease_end', e.target.value)}
                    />
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
                <div className="space-y-2">
                  <Label htmlFor="base_rent_amount">Base Rent Amount</Label>
                  <Input
                    id="base_rent_amount"
                    value={editableFields.base_rent_amount}
                    onChange={(e) => handleFieldChange('base_rent_amount', e.target.value)}
                    placeholder="e.g., $5,000"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="base_rent_frequency">Rent Frequency</Label>
                  <Input
                    id="base_rent_frequency"
                    value={editableFields.base_rent_frequency}
                    onChange={(e) => handleFieldChange('base_rent_frequency', e.target.value)}
                    placeholder="e.g., monthly, annually"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="security_deposit">Security Deposit</Label>
                  <Input
                    id="security_deposit"
                    value={editableFields.security_deposit}
                    onChange={(e) => handleFieldChange('security_deposit', e.target.value)}
                    placeholder="e.g., $10,000"
                  />
                </div>
                <div className="sm:col-span-2 space-y-2">
                  <Label htmlFor="escalation_clauses">Escalation Clauses</Label>
                  <Textarea
                    id="escalation_clauses"
                    value={editableFields.escalation_clauses}
                    onChange={(e) => handleFieldChange('escalation_clauses', e.target.value)}
                    placeholder="Summary of rent escalation terms"
                    rows={3}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Additional Terms */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Additional Terms</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="renewal_options">Renewal Options</Label>
                  <Textarea
                    id="renewal_options"
                    value={editableFields.renewal_options}
                    onChange={(e) => handleFieldChange('renewal_options', e.target.value)}
                    placeholder="Summary of renewal options"
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="termination_clauses">Termination Clauses</Label>
                  <Textarea
                    id="termination_clauses"
                    value={editableFields.termination_clauses}
                    onChange={(e) => handleFieldChange('termination_clauses', e.target.value)}
                    placeholder="Summary of termination provisions"
                    rows={3}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Key Dates */}
            {keyDates.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Key Dates</CardTitle>
                  <CardDescription>Important dates extracted from the lease</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {keyDates.map((item, index) => (
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
                <Button variant="outline" size="sm" className="w-full">
                  <Download className="h-4 w-4 mr-1" />
                  Download Original
                </Button>
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
