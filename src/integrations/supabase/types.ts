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
      leases: {
        Row: {
          base_rent_amount: string | null
          base_rent_frequency: string | null
          current_monthly_rent: number | null
          error_message: string | null
          extracted_json: Json | null
          filename: string
          id: string
          landlord_name: string | null
          lease_end: string | null
          lease_start: string | null
          processed_at: string | null
          rent_escalation_type: string | null
          status: string
          storage_path: string | null
          tenant_name: string | null
          uploaded_at: string
          user_id: string
          workspace_id: string | null
        }
        Insert: {
          base_rent_amount?: string | null
          base_rent_frequency?: string | null
          current_monthly_rent?: number | null
          error_message?: string | null
          extracted_json?: Json | null
          filename: string
          id?: string
          landlord_name?: string | null
          lease_end?: string | null
          lease_start?: string | null
          processed_at?: string | null
          rent_escalation_type?: string | null
          status?: string
          storage_path?: string | null
          tenant_name?: string | null
          uploaded_at?: string
          user_id: string
          workspace_id?: string | null
        }
        Update: {
          base_rent_amount?: string | null
          base_rent_frequency?: string | null
          current_monthly_rent?: number | null
          error_message?: string | null
          extracted_json?: Json | null
          filename?: string
          id?: string
          landlord_name?: string | null
          lease_end?: string | null
          lease_start?: string | null
          processed_at?: string | null
          rent_escalation_type?: string | null
          status?: string
          storage_path?: string | null
          tenant_name?: string | null
          uploaded_at?: string
          user_id?: string
          workspace_id?: string | null
        }
        Relationships: [
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
          email: string | null
          first_name: string | null
          id: string
          last_name: string | null
          plan: string
          processed_count: number
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
          email?: string | null
          first_name?: string | null
          id: string
          last_name?: string | null
          plan?: string
          processed_count?: number
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
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          plan?: string
          processed_count?: number
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
      workspace_members: {
        Row: {
          accepted_at: string | null
          created_at: string
          id: string
          invited_at: string | null
          invited_email: string | null
          role: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_email?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_email?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          user_id?: string
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
