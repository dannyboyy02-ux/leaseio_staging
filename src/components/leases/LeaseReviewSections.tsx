import { useState, useCallback } from 'react';
import { 
  Building2, 
  Calendar, 
  DollarSign, 
  FileText, 
  AlertTriangle,
  Users,
  MapPin,
  RefreshCw,
  ScrollText,
  Check,
  Pencil,
  X,
  Target,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ConfidenceScores } from '@/types/workflow';

// Field configuration by section
export const SECTION_CONFIG = {
  parties: {
    title: 'Parties',
    icon: Users,
    fields: [
      { id: 'landlord_name', label: 'Landlord', icon: Building2 },
      { id: 'tenant_name', label: 'Tenant', icon: Building2 },
    ],
  },
  property: {
    title: 'Property',
    icon: MapPin,
    fields: [
      { id: 'property_address', label: 'Property Address', icon: MapPin },
      { id: 'square_footage', label: 'Square Footage', icon: Building2, type: 'number' },
      { id: 'asset_type', label: 'Asset Type', icon: Building2 },
    ],
  },
  dates: {
    title: 'Dates & Term',
    icon: Calendar,
    fields: [
      { id: 'lease_start', label: 'Lease Start', icon: Calendar, type: 'date' },
      { id: 'lease_end', label: 'Lease End', icon: Calendar, type: 'date' },
      { id: 'rent_commencement_date', label: 'Rent Commencement', icon: Calendar, type: 'date' },
    ],
  },
  rent: {
    title: 'Rent',
    icon: DollarSign,
    fields: [
      { id: 'current_monthly_rent', label: 'Current Monthly Rent', icon: DollarSign, type: 'number' },
      { id: 'base_rent_amount', label: 'Base Rent Amount', icon: DollarSign },
      { id: 'base_rent_frequency', label: 'Rent Frequency', icon: RefreshCw },
      { id: 'security_deposit', label: 'Security Deposit', icon: DollarSign, type: 'number' },
      { id: 'rent_escalation_type', label: 'Escalation Type', icon: RefreshCw },
    ],
  },
  options: {
    title: 'Options & Clauses',
    icon: ScrollText,
    fields: [
      { id: 'renewal_options', label: 'Renewal Options', icon: RefreshCw, type: 'textarea' },
      { id: 'termination_clauses', label: 'Termination Clauses', icon: FileText, type: 'textarea' },
      { id: 'escalation_clauses', label: 'Escalation Clauses', icon: RefreshCw, type: 'textarea' },
    ],
  },
} as const;

export type SectionKey = keyof typeof SECTION_CONFIG;

// Confidence badge component
export const ConfidenceBadge = ({ confidence }: { confidence: number | null }) => {
  if (confidence === null) {
    return (
      <Badge variant="outline" className="text-[9px] h-4 font-medium text-muted-foreground bg-muted">
        <HelpCircle size={8} className="mr-0.5" />
        N/A
      </Badge>
    );
  }
  
  const percentage = Math.round(confidence * 100);
  
  if (confidence >= 0.90) {
    return (
      <Badge variant="outline" className="text-[9px] h-4 font-medium text-green-600 border-green-400 bg-green-50">
        <CheckCircle2 size={8} className="mr-0.5" />
        {percentage}%
      </Badge>
    );
  }
  
  if (confidence >= 0.70) {
    return (
      <Badge variant="outline" className="text-[9px] h-4 font-medium text-amber-600 border-amber-400 bg-amber-50">
        <AlertTriangle size={8} className="mr-0.5" />
        {percentage}%
      </Badge>
    );
  }
  
  return (
    <Badge variant="outline" className="text-[9px] h-4 font-medium text-red-600 border-red-400 bg-red-50">
      <XCircle size={8} className="mr-0.5" />
      {percentage}%
    </Badge>
  );
};

interface ExtractedField {
  value: any;
  page?: number;
  confidence: 'low' | 'medium' | 'high' | number;
  source_text?: string;
}

// Get confidence from extracted_json field
export const getFieldConfidence = (extractedJson: Record<string, any> | null, fieldId: string): number | null => {
  if (!extractedJson) return null;
  const field = extractedJson[fieldId] as ExtractedField | undefined;
  if (!field) return null;
  if (typeof field.confidence === 'number') return field.confidence;
  if (field.confidence === 'high') return 0.95;
  if (field.confidence === 'medium') return 0.80;
  if (field.confidence === 'low') return 0.60;
  return null;
};

// Get page from extracted_json field
export const getFieldPage = (extractedJson: Record<string, any> | null, fieldId: string): number | undefined => {
  if (!extractedJson) return undefined;
  const field = extractedJson[fieldId] as ExtractedField | undefined;
  return field?.page;
};

interface SectionCardProps {
  sectionKey: SectionKey;
  form: Record<string, string>;
  extractedJson: Record<string, any> | null;
  confidenceScores: ConfidenceScores;
  verifiedFields: Set<string>;
  isLocked: boolean;
  onFieldChange: (fieldId: string, value: string) => void;
  onFieldFocus: (fieldId: string) => void;
  onFieldBlur: (fieldId: string) => void;
  onVerifyField: (fieldId: string) => void;
  onJumpToPage: (page?: number) => void;
  confirmedSections: string[];
  onConfirmSection: (sectionKey: string) => void;
}

export function SectionCard({
  sectionKey,
  form,
  extractedJson,
  confidenceScores,
  verifiedFields,
  isLocked,
  onFieldChange,
  onFieldFocus,
  onFieldBlur,
  onVerifyField,
  onJumpToPage,
  confirmedSections,
  onConfirmSection,
}: SectionCardProps) {
  const [isEditing, setIsEditing] = useState(!isLocked);
  const section = SECTION_CONFIG[sectionKey];
  const Icon = section.icon;
  const isConfirmed = confirmedSections.includes(sectionKey);

  const getFieldBorderClass = (fieldId: string) => {
    const fieldConf = getFieldConfidence(extractedJson, fieldId);
    if (fieldConf !== null && fieldConf < 0.70) {
      return 'border-red-400 border-2';
    }
    if (fieldConf !== null && fieldConf < 0.80) {
      return 'border-amber-400 border-2';
    }
    if (verifiedFields.has(fieldId)) {
      return 'border-green-200 bg-green-50/20';
    }
    return '';
  };

  return (
    <Card className={cn(
      "shadow-none border overflow-hidden",
      isConfirmed && "border-green-300 bg-green-50/10"
    )}>
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Icon size={16} className="text-primary" />
            {section.title}
            {isConfirmed && (
              <Badge variant="outline" className="text-green-600 border-green-400 bg-green-50 text-[9px]">
                <Check size={8} className="mr-0.5" /> Reviewed
              </Badge>
            )}
          </span>
          <div className="flex items-center gap-2">
            {!isConfirmed && !isLocked && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onConfirmSection(sectionKey)}
                className="h-7 text-xs text-green-600 border-green-400 hover:bg-green-50"
              >
                <Check size={12} className="mr-1" />
                Mark Reviewed
              </Button>
            )}
            {!isLocked && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditing(!isEditing)}
                className="h-7"
              >
                {isEditing ? (
                  <>
                    <X size={12} className="mr-1" />
                    Done
                  </>
                ) : (
                  <>
                    <Pencil size={12} className="mr-1" />
                    Edit
                  </>
                )}
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {section.fields.map((field) => {
          const fieldConfidence = getFieldConfidence(extractedJson, field.id);
          const fieldPage = getFieldPage(extractedJson, field.id);
          const value = form[field.id] || '';
          const FieldIcon = field.icon;

          return (
            <div key={field.id} className="group">
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                  <FieldIcon size={12} />
                  {field.label}
                  <ConfidenceBadge confidence={fieldConfidence} />
                </Label>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                  {fieldPage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-primary"
                      title="Locate in PDF"
                      onClick={() => onJumpToPage(fieldPage)}
                    >
                      <Target size={12} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-6 w-6 transition-colors",
                      verifiedFields.has(field.id)
                        ? "text-green-600"
                        : "text-muted-foreground hover:text-green-600",
                    )}
                    onClick={() => onVerifyField(field.id)}
                  >
                    <ShieldCheck size={12} />
                  </Button>
                </div>
              </div>
              {field.type === 'textarea' ? (
                <Textarea
                  value={value}
                  onChange={(e) => onFieldChange(field.id, e.target.value)}
                  onFocus={() => onFieldFocus(field.id)}
                  onBlur={() => onFieldBlur(field.id)}
                  disabled={isLocked || !isEditing}
                  placeholder={`No ${field.label.toLowerCase()} extracted`}
                  className={cn(
                    "text-sm min-h-[80px]",
                    getFieldBorderClass(field.id),
                    (isLocked || !isEditing) && "bg-muted/30"
                  )}
                />
              ) : (
                <Input
                  type={field.type === 'number' ? 'text' : field.type === 'date' ? 'date' : 'text'}
                  value={value}
                  onChange={(e) => onFieldChange(field.id, e.target.value)}
                  onFocus={() => onFieldFocus(field.id)}
                  onBlur={() => onFieldBlur(field.id)}
                  disabled={isLocked || !isEditing}
                  placeholder={`No ${field.label.toLowerCase()} extracted`}
                  className={cn(
                    "text-sm",
                    getFieldBorderClass(field.id),
                    (isLocked || !isEditing) && "bg-muted/30",
                    !value && "text-muted-foreground italic"
                  )}
                />
              )}
              {!value && (
                <p className="text-[10px] text-muted-foreground mt-1 italic">
                  Field is empty — not extracted or not present in document
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// Risks section component
interface Risk {
  id: string;
  title: string;
  severity: string;
  explanation: string | null;
  citation_snippet: string | null;
  citation_page: number | null;
}

interface RisksSectionProps {
  risks: Risk[];
  onJumpToPage: (page?: number) => void;
}

export function RisksSection({ risks, onJumpToPage }: RisksSectionProps) {
  if (!risks || risks.length === 0) {
    return (
      <Card className="shadow-none border overflow-hidden">
        <CardHeader className="bg-muted/30 border-b py-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" />
            Risks
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground text-center py-4">
            No risks identified for this lease.
          </p>
        </CardContent>
      </Card>
    );
  }

  const getSeverityColor = (severity: string) => {
    switch (severity.toLowerCase()) {
      case 'high':
        return 'bg-red-100 text-red-700 border-red-300';
      case 'medium':
        return 'bg-amber-100 text-amber-700 border-amber-300';
      case 'low':
        return 'bg-blue-100 text-blue-700 border-blue-300';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <Card className="shadow-none border overflow-hidden">
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-600" />
          Risks
          <Badge variant="outline" className="ml-1">
            {risks.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {risks.map((risk) => (
          <div key={risk.id} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <h4 className="font-medium text-sm">{risk.title}</h4>
              <Badge className={cn("text-[10px]", getSeverityColor(risk.severity))}>
                {risk.severity}
              </Badge>
            </div>
            {risk.explanation && (
              <p className="text-sm text-muted-foreground">{risk.explanation}</p>
            )}
            {risk.citation_snippet && (
              <div className="text-xs bg-muted/50 p-2 rounded italic">
                "{risk.citation_snippet}"
                {risk.citation_page && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 ml-2 text-xs"
                    onClick={() => onJumpToPage(risk.citation_page || undefined)}
                  >
                    (Page {risk.citation_page})
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
