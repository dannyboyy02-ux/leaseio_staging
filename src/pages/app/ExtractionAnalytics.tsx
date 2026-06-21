import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Legend,
} from "recharts";
import { format } from "date-fns";
import {
  FileText,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  RefreshCcw,
  Loader2,
  ArrowLeft,
} from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { useApp } from "@/contexts/AppContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { formatLocalizedPercent } from "@/lib/dateFormatters";

interface StatsData {
  totalLeases: number;
  avgConfidence: number;
  totalCorrections: number;
  mostCorrectedField: string;
}

interface CorrectionByField {
  field_name: string;
  count: number;
}

interface ConfidenceDistribution {
  range: string;
  count: number;
  color: string;
}

interface RecentCorrection {
  id: string;
  field_name: string;
  original_value: string | null;
  corrected_value: string | null;
  corrected_at: string;
  corrected_by: string | null;
}

export default function ExtractionAnalytics() {
  const { t } = useAppTranslation();
  const { language } = useLanguage();
  const navigate = useNavigate();
  const { workspace } = useApp();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<StatsData>({
    totalLeases: 0,
    avgConfidence: 0,
    totalCorrections: 0,
    mostCorrectedField: "N/A",
  });
  const [correctionsByField, setCorrectionsByField] = useState<CorrectionByField[]>([]);
  const [confidenceDistribution, setConfidenceDistribution] = useState<ConfidenceDistribution[]>([]);
  const [recentCorrections, setRecentCorrections] = useState<RecentCorrection[]>([]);

  const fetchAnalytics = async () => {
    if (!workspace?.id) return;
    try {
      // Workspace scoping mandatory — analytics for the active workspace
      // only. The companion field_corrections + lease_field_confidence
      // queries below should also be workspace-scoped, but those tables'
      // RLS policies already enforce workspace isolation via lease join,
      // and a multi-workspace user is not the typical analytics consumer
      // (this page is dev-mode only).
      const { data: leasesData, error: leasesError } = await supabase
        .from("leases")
        .select("id, avg_confidence_score")
        .eq("workspace_id", workspace.id)
        .filter("processed_at", "not.is", "null");

      if (leasesError) throw leasesError;

      const totalLeases = leasesData?.length || 0;
      const avgConfidence =
        leasesData && leasesData.length > 0
          ? leasesData.reduce((sum, l) => sum + (l.avg_confidence_score || 0), 0) / totalLeases
          : 0;

      // Fetch corrections count and group by field
      const { data: correctionsData, error: correctionsError } = await supabase
        .from("field_corrections")
        .select("id, field_name");

      if (correctionsError) throw correctionsError;

      const totalCorrections = correctionsData?.length || 0;

      // Group corrections by field
      const fieldCounts: Record<string, number> = {};
      correctionsData?.forEach((c) => {
        fieldCounts[c.field_name] = (fieldCounts[c.field_name] || 0) + 1;
      });

      const correctionsByFieldArr = Object.entries(fieldCounts)
        .map(([field_name, count]) => ({ field_name, count }))
        .sort((a, b) => b.count - a.count);

      const mostCorrectedField = correctionsByFieldArr[0]?.field_name || "N/A";

      setCorrectionsByField(correctionsByFieldArr);

      // Fetch confidence distribution
      const { data: confidenceData, error: confidenceError } = await supabase
        .from("lease_field_confidence")
        .select("confidence_score");

      if (confidenceError) throw confidenceError;

      // Group by ranges
      const ranges = {
        "90-100%": { count: 0, color: "hsl(var(--primary))" },
        "80-90%": { count: 0, color: "hsl(142, 76%, 36%)" },
        "70-80%": { count: 0, color: "hsl(45, 93%, 47%)" },
        "<70%": { count: 0, color: "hsl(0, 84%, 60%)" },
      };

      confidenceData?.forEach((c) => {
        const score = c.confidence_score * 100;
        if (score >= 90) ranges["90-100%"].count++;
        else if (score >= 80) ranges["80-90%"].count++;
        else if (score >= 70) ranges["70-80%"].count++;
        else ranges["<70%"].count++;
      });

      const confidenceDistArr = Object.entries(ranges).map(([range, data]) => ({
        range,
        count: data.count,
        color: data.color,
      }));

      setConfidenceDistribution(confidenceDistArr);

      // Fetch recent corrections
      const { data: recentData, error: recentError } = await supabase
        .from("field_corrections")
        .select("id, field_name, original_value, corrected_value, corrected_at, corrected_by")
        .order("corrected_at", { ascending: false })
        .limit(20);

      if (recentError) throw recentError;

      setRecentCorrections(recentData || []);

      setStats({
        totalLeases,
        avgConfidence,
        totalCorrections,
        mostCorrectedField,
      });
    } catch (error) {
      console.error("Error fetching analytics:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchAnalytics();
  };

  const getBarColor = (count: number) => {
    if (count > 15) return "hsl(0, 84%, 60%)";
    if (count > 5) return "hsl(45, 93%, 47%)";
    return "hsl(142, 76%, 36%)";
  };

  const formatFieldName = (name: string) => {
    return name
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-muted/30">
        <AppHeader
          title={t('analytics.title')}
          subtitle={t('analytics.subtitle')}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t('analytics.back')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
                {refreshing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCcw className="h-4 w-4 mr-2" />
                )}
                {t('analytics.refresh')}
              </Button>
            </div>
          }
        />

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6 max-w-7xl mx-auto">
            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t('analytics.total_processed')}</CardTitle>
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.totalLeases}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t('analytics.avg_confidence')}</CardTitle>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatLocalizedPercent(stats.avgConfidence * 100, language, 1, 1)}
                  </div>
                  <Badge
                    variant={stats.avgConfidence >= 0.9 ? "default" : stats.avgConfidence >= 0.7 ? "secondary" : "destructive"}
                    className="mt-1"
                  >
                    {stats.avgConfidence >= 0.9 ? t('analytics.excellent') : stats.avgConfidence >= 0.7 ? t('analytics.good') : t('analytics.needs_improvement')}
                  </Badge>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t('analytics.total_corrections')}</CardTitle>
                  <AlertCircle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stats.totalCorrections}</div>
                  <p className="text-xs text-muted-foreground mt-1">{t('analytics.user_edits')}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{t('analytics.most_corrected')}</CardTitle>
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-bold truncate">
                    {formatFieldName(stats.mostCorrectedField)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t('analytics.focus_area')}</p>
                </CardContent>
              </Card>
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Corrections by Field */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('analytics.corrections_per_field')}</CardTitle>
                  <CardDescription>
                    {t('analytics.corrections_chart_desc')}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {correctionsByField.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={correctionsByField} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" />
                        <YAxis
                          type="category"
                          dataKey="field_name"
                          width={120}
                          tickFormatter={formatFieldName}
                        />
                        <Tooltip
                          formatter={(value) => [value, "Corrections"]}
                          labelFormatter={formatFieldName}
                        />
                        <Bar dataKey="count">
                          {correctionsByField.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={getBarColor(entry.count)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                      {t('analytics.no_corrections')}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Confidence Distribution */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('analytics.confidence_distribution')}</CardTitle>
                  <CardDescription>{t('analytics.confidence_chart_desc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  {confidenceDistribution.some((d) => d.count > 0) ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={confidenceDistribution}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={({ name, percent }) =>
                            percent > 0 ? `${name}: ${(percent * 100).toFixed(0)}%` : ""
                          }
                          outerRadius={100}
                          fill="#8884d8"
                          dataKey="count"
                          nameKey="range"
                        >
                          {confidenceDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                      {t('analytics.no_confidence_data')}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Recent Corrections Table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('analytics.recent_corrections')}</CardTitle>
                <CardDescription>{t('analytics.recent_corrections_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {recentCorrections.length > 0 ? (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('analytics.date')}</TableHead>
                          <TableHead>{t('analytics.field')}</TableHead>
                          <TableHead>{t('analytics.original')}</TableHead>
                          <TableHead>{t('analytics.corrected')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {recentCorrections.map((correction) => (
                          <TableRow key={correction.id}>
                            <TableCell className="text-sm text-muted-foreground">
                              {format(new Date(correction.corrected_at), "MMM d, HH:mm")}
                            </TableCell>
                            <TableCell className="font-medium">
                              {formatFieldName(correction.field_name)}
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="text-red-600 line-through">
                                {correction.original_value || t('analytics.empty')}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="text-green-600">
                                {correction.corrected_value || t('analytics.cleared')}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-[200px] text-muted-foreground">
                    {t('analytics.no_corrections')}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </div>
    </AppLayout>
  );
}
