import { FileText, Upload, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface EmptyLeaseStateProps {
  onUpload: () => void;
}

export function EmptyLeaseState({ onUpload }: EmptyLeaseStateProps) {
  return (
    <Card variant="ghost" className="border-2 border-dashed border-border">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold mb-2">No leases yet</h3>
        <p className="text-sm text-muted-foreground max-w-md mb-6">
          Upload your first lease document to get started. Our AI will automatically extract 
          key terms, dates, and financial information for you.
        </p>
        <Button variant="accent" size="lg" onClick={onUpload}>
          <Upload className="h-5 w-5 mr-2" />
          Upload Your First Lease
          <ArrowRight className="h-5 w-5 ml-2" />
        </Button>
        <p className="text-xs text-muted-foreground mt-4">
          Supports PDF files up to 50MB
        </p>
      </CardContent>
    </Card>
  );
}
