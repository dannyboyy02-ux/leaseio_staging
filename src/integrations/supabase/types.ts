export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      invite_tokens: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          role: Database["public"]["Enums"]["workspace_role"]
          token: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          token?: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          token?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invite_tokens_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_activity_log: {
        Row: {
          activity_type: string
          created_at: string
          details: Json | null
          from_status: string | null
          id: string
          lease_id: string
          to_status: string | null
          user_id: string | null
        }
        Insert: {
          activity_type: string
          created_at?: string
          details?: Json | null
          from_status?: string | null
          id?: string
          lease_id: string
          to_status?: string | null
          user_id?: string | null
        }
        Update: {
          activity_type?: string
          created_at?: string
          details?: Json | null
          from_status?: string | null
          id?: string
          lease_id?: string
          to_status?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lease_activity_log_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_approval_actions: {
        Row: {
          action: string
          approval_type: string
          approver_id: string
          comment: string | null
          created_at: string
          id: string
          lease_id: string
        }
        Insert: {
          action: string
          approval_type: string
          approver_id: string
          comment?: string | null
          created_at?: string
          id?: string
          lease_id: string
        }
        Update: {
          action?: string
          approval_type?: string
          approver_id?: string
          comment?: string | null
          created_at?: string
          id?: string
          lease_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_approval_actions_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_approvers: {
        Row: {
          approval_type: string
          approved_at: string | null
          approver_id: string
          created_at: string
          id: string
          lease_id: string
        }
        Insert: {
          approval_type: string
          approved_at?: string | null
          approver_id: string
          created_at?: string
          id?: string
          lease_id: string
        }
        Update: {
          approval_type?: string
          approved_at?: string | null
          approver_id?: string
          created_at?: string
          id?: string
          lease_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_approvers_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_field_confidence: {
        Row: {
          confidence_score: number
          corrected_at: string | null
          created_at: string | null
          field_name: string
          id: string
          lease_id: string
          was_corrected: boolean | null
        }
        Insert: {
          confidence_score: number
          corrected_at?: string | null
          created_at?: string | null
          field_name: string
          id?: string
          lease_id: string
          was_corrected?: boolean | null
        }
        Update: {
          confidence_score?: number
          corrected_at?: string | null
          created_at?: string | null
          field_name?: string
          id?: string
          lease_id?: string
          was_corrected?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "lease_field_confidence_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_notifications: {
        Row: {
          created_at: string
          event_date: string
          event_description: string | null
          event_type: string
          id: string
          is_confirmed: boolean
          last_notified_at: string | null
          lease_id: string
          notify_days_before: number[]
          notify_email: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_date: string
          event_description?: string | null
          event_type: string
          id?: string
          is_confirmed?: boolean
          last_notified_at?: string | null
          lease_id: string
          notify_days_before?: number[]
          notify_email?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_date?: string
          event_description?: string | null
          event_type?: string
          id?: string
          is_confirmed?: boolean
          last_notified_at?: string | null
          lease_id?: string
          notify_days_before?: number[]
          notify_email?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_notifications_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_nudges: {
        Row: {
          channel: string
          id: string
          lease_id: string
          nudge_type: string
          sent_at: string
          sent_by: string | null
        }
        Insert: {
          channel: string
          id?: string
          lease_id: string
          nudge_type: string
          sent_at?: string
          sent_by?: string | null
        }
        Update: {
          channel?: string
          id?: string
          lease_id?: string
          nudge_type?: string
          sent_at?: string
          sent_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lease_nudges_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      leases: {
        Row: {
          activated_at: string | null
          approver_email: string | null
          audit_log: Json | null
          avg_confidence_score: number | null
          base_rent_amount: string | null
          base_rent_frequency: string | null
          business_unit: string | null
          category: string | null
          confidence_scores: Json | null
          confirmed_sections: string[]
          current_monthly_rent: number | null
          error_message: string | null
          estimated_monthly_cost_max: number | null
          estimated_monthly_cost_min: number | null
          estimated_term_max: number | null
          estimated_term_min: number | null
          execution_approved_at: string | null
          extracted_json: Json | null
          filename: string
          id: string
          initializer_id: string | null
          internal_approved_at: string | null
          landlord_name: string | null
          last_nudged_at: string | null
          lease_end: string | null
          lease_owner_id: string | null
          lease_start: string | null
          lease_type: string | null
          lifecycle_status: string | null
          notes: string | null
          parent_lease_id: string | null
          processed_at: string | null
          rejection_reason: string | null
          rent_escalation_type: string | null
          square_footage: number | null
          status: string
          storage_path: string | null
          submitted_for_approval_at: string | null
          tenant_name: string | null
          uploaded_at: string
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          activated_at?: string | null
          approver_email?: string | null
          audit_log?: Json | null
          avg_confidence_score?: number | null
          base_rent_amount?: string | null
          base_rent_frequency?: string | null
          business_unit?: string | null
          category?: string | null
          confidence_scores?: Json | null
          confirmed_sections?: string[]
          current_monthly_rent?: number | null
          error_message?: string | null
          estimated_monthly_cost_max?: number | null
          estimated_monthly_cost_min?: number | null
          estimated_term_max?: number | null
          estimated_term_min?: number | null
          execution_approved_at?: string | null
          extracted_json?: Json | null
          filename: string
          id?: string
          initializer_id?: string | null
          internal_approved_at?: string | null
          landlord_name?: string | null
          last_nudged_at?: string | null
          lease_end?: string | null
          lease_owner_id?: string | null
          lease_start?: string | null
          lease_type?: string | null
          lifecycle_status?: string | null
          notes?: string | null
          parent_lease_id?: string | null
          processed_at?: string | null
          rejection_reason?: string | null
          rent_escalation_type?: string | null
          square_footage?: number | null
          status?: string
          storage_path?: string | null
          submitted_for_approval_at?: string | null
          tenant_name?: string | null
          uploaded_at?: string
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          activated_at?: string | null
          approver_email?: string | null
          audit_log?: Json | null
          avg_confidence_score?: number | null
          base_rent_amount?: string | null
          base_rent_frequency?: string | null
          business_unit?: string | null
          category?: string | null
          confidence_scores?: Json | null
          confirmed_sections?: string[]
          current_monthly_rent?: number | null
          error_message?: string | null
          estimated_monthly_cost_max?: number | null
          estimated_monthly_cost_min?: number | null
          estimated_term_max?: number | null
          estimated_term_min?: number | null
          execution_approved_at?: string | null
          extracted_json?: Json | null
          filename?: string
          id?: string
          initializer_id?: string | null
          internal_approved_at?: string | null
          landlord_name?: string | null
          last_nudged_at?: string | null
          lease_end?: string | null
          lease_owner_id?: string | null
          lease_start?: string | null
          lease_type?: string | null
          lifecycle_status?: string | null
          notes?: string | null
          parent_lease_id?: string | null
          processed_at?: string | null
          rejection_reason?: string | null
          rent_escalation_type?: string | null
          square_footage?: number | null
          status?: string
          storage_path?: string | null
          submitted_for_approval_at?: string | null
          tenant_name?: string | null
          uploaded_at?: string
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leases_parent_lease_id_fkey"
            columns: ["parent_lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leases_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leases_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          billing_interval: string
          company_name: string | null
          created_at: string
          current_workspace_id: string | null
          email: string | null
          email_notifications_enabled: boolean
          first_name: string | null
          id: string
          last_name: string | null
          plan: string
          processed_count: number
          sms_notifications_enabled: boolean
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_period_end: string | null
          subscription_status: string | null
          timezone: string | null
          trial_ends_at: string | null
        }
        Insert: {
          billing_interval?: string
          company_name?: string | null
          created_at?: string
          current_workspace_id?: string | null
          email?: string | null
          email_notifications_enabled?: boolean
          first_name?: string | null
          id: string
          last_name?: string | null
          plan?: string
          processed_count?: number
          sms_notifications_enabled?: boolean
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_period_end?: string | null
          subscription_status?: string | null
          timezone?: string | null
          trial_ends_at?: string | null
        }
        Update: {
          billing_interval?: string
          company_name?: string | null
          created_at?: string
          current_workspace_id?: string | null
          email?: string | null
          email_notifications_enabled?: boolean
          first_name?: string | null
          id?: string
          last_name?: string | null
          plan?: string
          processed_count?: number
          sms_notifications_enabled?: boolean
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_period_end?: string | null
          subscription_status?: string | null
          timezone?: string | null
          trial_ends_at?: string | null
        }
        Relationships: []
      }
      rent_schedules: {
        Row: {
          annual_amount: number | null
          created_at: string
          id: string
          lease_id: string
          monthly_amount: number | null
          notes: string | null
          period_end: string | null
          period_start: string
          updated_at: string
        }
        Insert: {
          annual_amount?: number | null
          created_at?: string
          id?: string
          lease_id: string
          monthly_amount?: number | null
          notes?: string | null
          period_end?: string | null
          period_start: string
          updated_at?: string
        }
        Update: {
          annual_amount?: number | null
          created_at?: string
          id?: string
          lease_id?: string
          monthly_amount?: number | null
          notes?: string | null
          period_end?: string | null
          period_start?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_schedules_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      risks: {
        Row: {
          citation_page: number | null
          citation_snippet: string | null
          explanation: string | null
          id: string
          lease_id: string
          severity: string
          title: string
        }
        Insert: {
          citation_page?: number | null
          citation_snippet?: string | null
          explanation?: string | null
          id?: string
          lease_id: string
          severity: string
          title: string
        }
        Update: {
          citation_page?: number | null
          citation_snippet?: string | null
          explanation?: string | null
          id?: string
          lease_id?: string
          severity?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "risks_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_approvers: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_approvers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          accepted_at: string | null
          created_at: string
          id: string
          invited_at: string | null
          invited_email: string | null
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_email?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_email?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          billing_interval: string
          created_at: string
          default_notification_days: number
          document_limit: number
          documents_used: number
          id: string
          name: string
          owner_id: string
          plan: string
          timezone: string
          updated_at: string
        }
        Insert: {
          billing_interval?: string
          created_at?: string
          default_notification_days?: number
          document_limit?: number
          documents_used?: number
          id?: string
          name: string
          owner_id: string
          plan?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          billing_interval?: string
          created_at?: string
          default_notification_days?: number
          document_limit?: number
          documents_used?: number
          id?: string
          name?: string
          owner_id?: string
          plan?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_workspace_role: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: Database["public"]["Enums"]["workspace_role"]
      }
      has_workspace_permission: {
        Args: {
          _min_role: Database["public"]["Enums"]["workspace_role"]
          _user_id: string
          _workspace_id: string
        }
        Returns: boolean
      }
      is_workspace_member: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
      is_workspace_owner: {
        Args: { _user_id: string; _workspace_id: string }
        Returns: boolean
      }
    }
    Enums: {
      subscription_plan: "free" | "starter" | "pro" | "business"
      workspace_role: "admin" | "editor" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      subscription_plan: ["free", "starter", "pro", "business"],
      workspace_role: ["admin", "editor", "viewer"],
    },
  },
} as const
