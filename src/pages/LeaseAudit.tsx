import { useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Upload, X, FileText, Loader2, CheckCircle2,
  Building2, TrendingUp, AlertTriangle, Sparkles, Shield,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

const MAX_DOCS = 5;
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/audit-session`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

interface ExtractedLease {
  id: string;
  filename: string;
  landlord_name: string | null;
  tenant_name: string | null;
  property_address: string | null;
  asset_type: string | null;
  lease_start: string | null;
  lease_end: string | null;
  term_months: number | null;
  current_monthly_rent: number | null;
  escalation_type: string | null;
  escalation_rate: number | null;
  security_deposit: string | null;
  renewal_options: string | null;
  termination_clauses: string | null;
  risks: Array<{ title: string; severity: string; explanation: string }>;
}

interface FileItem {
  file: File;
  status: 'queued' | 'processing' | 'done' | 'error';
  error?: string;
  lease?: ExtractedLease;
}

type Step = 'collect' | 'processing' | 'results';

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return d; }
}

function capitalize(s: string | null): string {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function LeaseAudit() {
  const [step, setStep] = useState<Step>('collect');
  const [formError, setFormError] = useState('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [leases, setLeases] = useState<ExtractedLease[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const pdfs = Array.from(incoming).filter((f) => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    setFiles((prev) => {
      const combined = [...prev, ...pdfs.map((f): FileItem => ({ file: f, status: 'queued' }))];
      return combined.slice(0, MAX_DOCS);
    });
  }, []);

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const startAudit = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setFormError('Please sign in before starting an audit.');
      return;
    }
    if (files.length === 0) {
      setFormError('Please upload at least one PDF.');
      return;
    }
    setFormError('');
    setStep('processing');

    let currentWorkspaceId: string | null = workspaceId;
    const completedLeases: ExtractedLease[] = [];

    for (let i = 0; i < files.length; i++) {
      setFiles((prev) =>
        prev.map((f, idx) => idx === i ? { ...f, status: 'processing' } : f),
      );

      const form = new FormData();
      form.append('file', files[i].file);
      if (currentWorkspaceId) form.append('workspaceId', currentWorkspaceId);

      try {
        const res = await fetch(FUNCTION_URL, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: form,
        });
        const data = await res.json();

        if (!res.ok || data.error) {
          setFiles((prev) =>
            prev.map((f, idx) => idx === i ? { ...f, status: 'error', error: data.error || 'Analysis failed' } : f),
          );
          if (data.limitReached) break;
          continue;
        }

        currentWorkspaceId = data.workspaceId;
        setWorkspaceId(data.workspaceId);
        completedLeases.push(data.lease);
        setFiles((prev) =>
          prev.map((f, idx) => idx === i ? { ...f, status: 'done', lease: data.lease } : f),
        );
      } catch {
        setFiles((prev) =>
          prev.map((f, idx) => idx === i ? { ...f, status: 'error', error: 'Network error' } : f),
        );
      }
    }

    setLeases(completedLeases);
    setStep('results');
  };

  // ---- Portfolio summary computations ----
  const totalMonthly = leases.reduce((s, l) => s + (l.current_monthly_rent ?? 0), 0);
  const annualObligation = totalMonthly * 12;

  const assetBreakdown = Object.entries(
    leases.reduce((acc, l) => {
      const k = l.asset_type ?? 'unclassified';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  ).sort((a, b) => b[1] - a[1]);

  const escalationBreakdown = Object.entries(
    leases.reduce((acc, l) => {
      const k = l.escalation_type ?? 'none';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  ).sort((a, b) => b[1] - a[1]);

  const riskCounts = leases.flatMap((l) => l.risks).reduce(
    (acc, r) => { acc[r.severity] = (acc[r.severity] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="border-b border-border bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 font-display font-bold text-foreground">
            <Sparkles className="h-5 w-5 text-primary" />
            LeaseIO
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm text-muted-foreground hover:text-foreground">Sign in</Link>
            <Button size="sm" asChild>
              <Link to="/signup?plan=starter">Get Started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-12">
        {step === 'collect' && (
          <CollectStep
            formError={formError}
            files={files}
            dragging={dragging}
            setDragging={setDragging}
            onDrop={onDrop}
            addFiles={addFiles}
            removeFile={removeFile}
            fileInputRef={fileInputRef}
            onStart={startAudit}
          />
        )}

        {step === 'processing' && (
          <ProcessingStep files={files} />
        )}

        {step === 'results' && (
          <ResultsStep
            leases={leases}
            totalMonthly={totalMonthly}
            annualObligation={annualObligation}
            assetBreakdown={assetBreakdown}
            escalationBreakdown={escalationBreakdown}
            riskCounts={riskCounts}
          />
        )}
      </main>
    </div>
  );
}

// =====================================================================
// STEP 1 — Collect
// =====================================================================
function CollectStep({
  formError, files, dragging, setDragging,
  onDrop, addFiles, removeFile, fileInputRef, onStart,
}: {
  formError: string;
  files: FileItem[];
  dragging: boolean;
  setDragging: (v: boolean) => void;
  onDrop: (e: React.DragEvent) => void;
  addFiles: (f: FileList | File[]) => void;
  removeFile: (i: number) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onStart: () => void;
}) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
          <Sparkles className="h-3.5 w-3.5" />
          Authenticated audit workspace
        </div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-3">
          Your free lease audit
        </h1>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Upload up to {MAX_DOCS} lease PDFs. Claude reads each one and tells you what's in them - monthly obligations, key dates, escalation terms, and risks.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-5">
          {/* Dropzone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors',
              dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/30',
            )}
          >
            <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground">
              Drop lease PDFs here or <span className="text-primary">browse</span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              PDF only · max 20 MB each · up to {MAX_DOCS} documents
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
          </div>

          {/* File list */}
          {files.length > 0 && (
            <ul className="space-y-2">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate text-sm">{f.file.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFile(i); }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Button
            className="w-full"
            size="lg"
            onClick={onStart}
            disabled={files.length === 0}
          >
            Analyze My Leases
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          {formError && (
            <p className="text-xs text-destructive text-center">{formError}</p>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Shield className="h-3.5 w-3.5" /> Bank-grade security</span>
        <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Powered by Claude AI</span>
      </div>
    </div>
  );
}

// =====================================================================
// STEP 2 — Processing
// =====================================================================
function ProcessingStep({ files }: { files: FileItem[] }) {
  const done  = files.filter((f) => f.status === 'done').length;
  const total = files.length;

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold text-foreground mb-2">Analyzing your leases…</h2>
        <p className="text-muted-foreground text-sm">
          Claude is reading each document. This takes 20–60 seconds per file.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-3">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-3">
              <div className="shrink-0">
                {f.status === 'queued'     && <FileText className="h-5 w-5 text-muted-foreground" />}
                {f.status === 'processing' && <Loader2 className="h-5 w-5 text-primary animate-spin" />}
                {f.status === 'done'       && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                {f.status === 'error'      && <AlertTriangle className="h-5 w-5 text-destructive" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{f.file.name}</p>
                {f.status === 'processing' && <p className="text-xs text-muted-foreground">Reading with Claude…</p>}
                {f.status === 'done'       && <p className="text-xs text-green-600">Extracted</p>}
                {f.status === 'error'      && <p className="text-xs text-destructive">{f.error}</p>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {done < total && (
        <p className="text-center text-sm text-muted-foreground">
          {done} of {total} complete
        </p>
      )}
    </div>
  );
}

// =====================================================================
// STEP 3 — Results
// =====================================================================
function ResultsStep({
  leases, totalMonthly, annualObligation, assetBreakdown, escalationBreakdown, riskCounts,
}: {
  leases: ExtractedLease[];
  totalMonthly: number;
  annualObligation: number;
  assetBreakdown: [string, number][];
  escalationBreakdown: [string, number][];
  riskCounts: Record<string, number>;
}) {
  const highRisks = riskCounts['high'] ?? 0;

  if (leases.length === 0) {
    return (
      <div className="text-center py-16 space-y-4">
        <AlertTriangle className="h-10 w-10 text-muted-foreground mx-auto" />
        <p className="font-medium text-foreground">No leases were extracted successfully.</p>
        <p className="text-sm text-muted-foreground">Please check your files and try again.</p>
        <Button variant="outline" onClick={() => window.location.reload()}>Try Again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400 text-xs font-medium mb-4">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Analysis complete
        </div>
        <h2 className="font-display text-2xl sm:text-3xl font-bold text-foreground mb-2">
          Your lease portfolio snapshot
        </h2>
        <p className="text-muted-foreground text-sm max-w-xl mx-auto">
          Based on {leases.length} document{leases.length !== 1 ? 's' : ''} analyzed by Claude.
        </p>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Leases Analyzed</p>
            <p className="text-2xl font-bold font-display">{leases.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Monthly Obligation</p>
            <p className="text-2xl font-bold font-display">{fmt(totalMonthly)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Annual Obligation</p>
            <p className="text-2xl font-bold font-display">{fmt(annualObligation)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1">High-Risk Clauses</p>
            <p className={cn('text-2xl font-bold font-display', highRisks > 0 && 'text-destructive')}>
              {highRisks}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Asset + Escalation mix */}
      {(assetBreakdown.length > 0 || escalationBreakdown.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {assetBreakdown.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Building2 className="h-4 w-4" /> Asset Mix
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {assetBreakdown.map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{type.replace(/_/g, ' ')}</span>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {escalationBreakdown.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <TrendingUp className="h-4 w-4" /> Escalation Mix
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {escalationBreakdown.map(([type, count]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{type.replace(/_/g, ' ')}</span>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Per-lease cards */}
      <div className="space-y-4">
        <h3 className="font-semibold text-foreground">Lease Details</h3>
        {leases.map((lease) => (
          <LeaseCard key={lease.id} lease={lease} />
        ))}
      </div>

      {/* Upgrade CTA */}
      <Card className="bg-primary text-primary-foreground border-0">
        <CardContent className="pt-6 pb-6 text-center space-y-4">
          <Sparkles className="h-8 w-8 mx-auto opacity-80" />
          <div>
            <h3 className="font-display text-xl font-bold mb-1">Unlock your full portfolio</h3>
            <p className="text-primary-foreground/80 text-sm max-w-sm mx-auto">
              Manage all your leases, get approval workflows, track renewals, and ask Claude anything about your portfolio.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button size="lg" variant="secondary" asChild>
              <Link to="/signup?plan=starter">
                Start with Starter — $249/mo
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" className="border-primary-foreground/30 text-primary-foreground hover:bg-primary-foreground/10" asChild>
              <Link to="/signup?plan=business">See Business Plan</Link>
            </Button>
          </div>
          <p className="text-xs text-primary-foreground/60">No credit card required to start</p>
        </CardContent>
      </Card>
    </div>
  );
}

function LeaseCard({ lease }: { lease: ExtractedLease }) {
  const highRisks   = lease.risks.filter((r) => r.severity === 'high').length;
  const mediumRisks = lease.risks.filter((r) => r.severity === 'medium').length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">{lease.filename}</CardTitle>
            {lease.property_address && (
              <CardDescription className="text-xs mt-0.5">{lease.property_address}</CardDescription>
            )}
          </div>
          <div className="flex gap-1.5 shrink-0">
            {lease.asset_type && (
              <Badge variant="outline" className="text-xs capitalize">
                {lease.asset_type.replace(/_/g, ' ')}
              </Badge>
            )}
            {highRisks > 0 && (
              <Badge variant="destructive" className="text-xs">{highRisks} high risk</Badge>
            )}
            {highRisks === 0 && mediumRisks > 0 && (
              <Badge variant="secondary" className="text-xs">{mediumRisks} medium risk</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground">Tenant</p>
            <p className="font-medium truncate">{lease.tenant_name ?? '—'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Landlord</p>
            <p className="font-medium truncate">{lease.landlord_name ?? '—'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Start → End</p>
            <p className="font-medium">{fmtDate(lease.lease_start)} → {fmtDate(lease.lease_end)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Monthly Rent</p>
            <p className="font-medium">
              {lease.current_monthly_rent ? fmt(lease.current_monthly_rent) : '—'}
            </p>
          </div>
        </div>

        {(lease.escalation_type || lease.security_deposit) && (
          <div className="grid grid-cols-2 gap-3 text-xs">
            {lease.escalation_type && (
              <div>
                <p className="text-muted-foreground">Escalation</p>
                <p className="font-medium">
                  {capitalize(lease.escalation_type)}
                  {lease.escalation_rate ? ` (${lease.escalation_rate}%)` : ''}
                </p>
              </div>
            )}
            {lease.security_deposit && (
              <div>
                <p className="text-muted-foreground">Security Deposit</p>
                <p className="font-medium">{lease.security_deposit}</p>
              </div>
            )}
          </div>
        )}

        {lease.risks.length > 0 && (
          <div className="space-y-1.5">
            {lease.risks.slice(0, 3).map((r, i) => (
              <div
                key={i}
                className={cn(
                  'rounded-md px-3 py-2 text-xs',
                  r.severity === 'high'   && 'bg-destructive/10 text-destructive',
                  r.severity === 'medium' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400',
                  r.severity === 'low'    && 'bg-muted text-muted-foreground',
                )}
              >
                <span className="font-medium capitalize">{r.severity}: </span>{r.title}
              </div>
            ))}
            {lease.risks.length > 3 && (
              <p className="text-xs text-muted-foreground pl-1">+{lease.risks.length - 3} more risks</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
