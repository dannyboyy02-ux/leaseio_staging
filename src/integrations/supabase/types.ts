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
      alert_rules: {
        Row: {
          alert_type: string
          created_at: string
          id: string
          is_active: boolean
          threshold_days: number | null
          threshold_value: number | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          alert_type: string
          created_at?: string
          id?: string
          is_active?: boolean
          threshold_days?: number | null
          threshold_value?: number | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          alert_type?: string
          created_at?: string
          id?: string
          is_active?: boolean
          threshold_days?: number | null
          threshold_value?: number | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_chain_steps: {
        Row: {
          approver_role: string | null
          approver_user_id: string | null
          created_at: string
          delegate_after_days: number | null
          delegate_user_id: string | null
          id: string
          is_required: boolean
          parallel_group: number
          policy_id: string
          stage: string
          step_order: number
        }
        Insert: {
          approver_role?: string | null
          approver_user_id?: string | null
          created_at?: string
          delegate_after_days?: number | null
          delegate_user_id?: string | null
          id?: string
          is_required?: boolean
          parallel_group?: number
          policy_id: string
          stage: string
          step_order: number
        }
        Update: {
          approver_role?: string | null
          approver_user_id?: string | null
          created_at?: string
          delegate_after_days?: number | null
          delegate_user_id?: string | null
          id?: string
          is_required?: boolean
          parallel_group?: number
          policy_id?: string
          stage?: string
          step_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_chain_steps_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "approval_policies"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_policies: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          id: string
          is_active: boolean
          is_default_fallback: boolean
          match_asset_types: string[]
          match_departments: string[]
          match_lease_types: string[]
          match_max_annual_cost: number | null
          match_min_annual_cost: number | null
          match_regions: string[]
          name: string
          priority: number
          separation_of_duties_override: boolean | null
          updated_at: string
          updated_by: string
          version: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_default_fallback?: boolean
          match_asset_types?: string[]
          match_departments?: string[]
          match_lease_types?: string[]
          match_max_annual_cost?: number | null
          match_min_annual_cost?: number | null
          match_regions?: string[]
          name: string
          priority?: number
          separation_of_duties_override?: boolean | null
          updated_at?: string
          updated_by: string
          version?: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_default_fallback?: boolean
          match_asset_types?: string[]
          match_departments?: string[]
          match_lease_types?: string[]
          match_max_annual_cost?: number | null
          match_min_annual_cost?: number | null
          match_regions?: string[]
          name?: string
          priority?: number
          separation_of_duties_override?: boolean | null
          updated_at?: string
          updated_by?: string
          version?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_policies_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      deleted_workspaces: {
        Row: {
          deleted_at: string
          deleted_by: string | null
          id: string
          lease_count_at_deletion: number | null
          member_count_at_deletion: number | null
          original_workspace_id: string
          owner_id: string
          storage_objects_purged: number | null
          workspace_name: string | null
          workspace_plan: string | null
        }
        Insert: {
          deleted_at?: string
          deleted_by?: string | null
          id?: string
          lease_count_at_deletion?: number | null
          member_count_at_deletion?: number | null
          original_workspace_id: string
          owner_id: string
          storage_objects_purged?: number | null
          workspace_name?: string | null
          workspace_plan?: string | null
        }
        Update: {
          deleted_at?: string
          deleted_by?: string | null
          id?: string
          lease_count_at_deletion?: number | null
          member_count_at_deletion?: number | null
          original_workspace_id?: string
          owner_id?: string
          storage_objects_purged?: number | null
          workspace_name?: string | null
          workspace_plan?: string | null
        }
        Relationships: []
      }
      dismissed_events: {
        Row: {
          created_at: string
          dismissed_at: string
          event_key: string
          expires_at: string | null
          id: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          dismissed_at?: string
          event_key: string
          expires_at?: string | null
          id?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          dismissed_at?: string
          event_key?: string
          expires_at?: string | null
          id?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dismissed_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      executed_term_edits: {
        Row: {
          edited_at: string
          edited_by: string
          edited_value: string | null
          field_name: string
          id: string
          lease_id: string
          original_value: string | null
          reason: string | null
        }
        Insert: {
          edited_at?: string
          edited_by: string
          edited_value?: string | null
          field_name: string
          id?: string
          lease_id: string
          original_value?: string | null
          reason?: string | null
        }
        Update: {
          edited_at?: string
          edited_by?: string
          edited_value?: string | null
          field_name?: string
          id?: string
          lease_id?: string
          original_value?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "executed_term_edits_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "executed_term_edits_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      field_corrections: {
        Row: {
          ai_confidence: number | null
          corrected_at: string | null
          corrected_by: string | null
          corrected_value: string | null
          correction_type: string | null
          field_name: string
          id: string
          lease_id: string
          original_value: string | null
          user_notes: string | null
        }
        Insert: {
          ai_confidence?: number | null
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_value?: string | null
          correction_type?: string | null
          field_name: string
          id?: string
          lease_id: string
          original_value?: string | null
          user_notes?: string | null
        }
        Update: {
          ai_confidence?: number | null
          corrected_at?: string | null
          corrected_by?: string | null
          corrected_value?: string | null
          correction_type?: string | null
          field_name?: string
          id?: string
          lease_id?: string
          original_value?: string | null
          user_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "field_corrections_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_corrections_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_tokens: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          first_name: string | null
          id: string
          last_name: string | null
          role: Database["public"]["Enums"]["workspace_role"]
          token: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          role?: Database["public"]["Enums"]["workspace_role"]
          token?: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
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
          {
            foreignKeyName: "lease_activity_log_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_activity_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
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
          {
            foreignKeyName: "lease_approval_actions_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_approval_chain: {
        Row: {
          action_at: string | null
          action_by: string | null
          approver_role: string | null
          approver_user_id: string | null
          comment: string | null
          created_at: string
          delegate_after_days: number | null
          delegate_user_id: string | null
          id: string
          is_required: boolean
          lease_id: string
          parallel_group: number
          policy_id: string | null
          policy_version: number | null
          rerouted_from_chain_id: string | null
          stage: string
          status: string
          step_order: number
          workspace_id: string
        }
        Insert: {
          action_at?: string | null
          action_by?: string | null
          approver_role?: string | null
          approver_user_id?: string | null
          comment?: string | null
          created_at?: string
          delegate_after_days?: number | null
          delegate_user_id?: string | null
          id?: string
          is_required?: boolean
          lease_id: string
          parallel_group?: number
          policy_id?: string | null
          policy_version?: number | null
          rerouted_from_chain_id?: string | null
          stage: string
          status?: string
          step_order: number
          workspace_id: string
        }
        Update: {
          action_at?: string | null
          action_by?: string | null
          approver_role?: string | null
          approver_user_id?: string | null
          comment?: string | null
          created_at?: string
          delegate_after_days?: number | null
          delegate_user_id?: string | null
          id?: string
          is_required?: boolean
          lease_id?: string
          parallel_group?: number
          policy_id?: string | null
          policy_version?: number | null
          rerouted_from_chain_id?: string | null
          stage?: string
          status?: string
          step_order?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_approval_chain_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_approval_chain_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_approval_chain_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "approval_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_approval_chain_rerouted_from_chain_id_fkey"
            columns: ["rerouted_from_chain_id"]
            isOneToOne: false
            referencedRelation: "lease_approval_chain"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_approval_chain_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
          {
            foreignKeyName: "lease_approvers_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_change_set_items: {
        Row: {
          change_set_id: string
          created_at: string
          field_label: string
          field_name: string
          id: string
          old_value: string | null
          proposed_value: string | null
          source_section: string | null
        }
        Insert: {
          change_set_id: string
          created_at?: string
          field_label: string
          field_name: string
          id?: string
          old_value?: string | null
          proposed_value?: string | null
          source_section?: string | null
        }
        Update: {
          change_set_id?: string
          created_at?: string
          field_label?: string
          field_name?: string
          id?: string
          old_value?: string | null
          proposed_value?: string | null
          source_section?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lease_change_set_items_change_set_id_fkey"
            columns: ["change_set_id"]
            isOneToOne: false
            referencedRelation: "lease_change_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_change_sets: {
        Row: {
          change_summary: string | null
          created_at: string
          id: string
          lease_id: string
          requested_approver_id: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          self_approved: boolean
          status: string
          submitted_at: string | null
          submitted_by: string
          unlock_request_id: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          change_summary?: string | null
          created_at?: string
          id?: string
          lease_id: string
          requested_approver_id?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          self_approved?: boolean
          status?: string
          submitted_at?: string | null
          submitted_by: string
          unlock_request_id?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          change_summary?: string | null
          created_at?: string
          id?: string
          lease_id?: string
          requested_approver_id?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          self_approved?: boolean
          status?: string
          submitted_at?: string | null
          submitted_by?: string
          unlock_request_id?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_change_sets_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_change_sets_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_change_sets_unlock_request_id_fkey"
            columns: ["unlock_request_id"]
            isOneToOne: false
            referencedRelation: "lease_unlock_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_change_sets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_documents: {
        Row: {
          created_at: string
          document_type: string
          file_size_bytes: number | null
          filename: string
          id: string
          is_current_latest: boolean
          iteration_number: number
          lease_id: string
          mime_type: string | null
          notes: string | null
          storage_path: string
          superseded_at: string | null
          superseded_by: string | null
          uploaded_at: string
          uploaded_by: string
          version_number: number
          workspace_id: string
        }
        Insert: {
          created_at?: string
          document_type: string
          file_size_bytes?: number | null
          filename: string
          id?: string
          is_current_latest?: boolean
          iteration_number: number
          lease_id: string
          mime_type?: string | null
          notes?: string | null
          storage_path: string
          superseded_at?: string | null
          superseded_by?: string | null
          uploaded_at?: string
          uploaded_by: string
          version_number: number
          workspace_id: string
        }
        Update: {
          created_at?: string
          document_type?: string
          file_size_bytes?: number | null
          filename?: string
          id?: string
          is_current_latest?: boolean
          iteration_number?: number
          lease_id?: string
          mime_type?: string | null
          notes?: string | null
          storage_path?: string
          superseded_at?: string | null
          superseded_by?: string | null
          uploaded_at?: string
          uploaded_by?: string
          version_number?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_documents_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_documents_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_documents_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "lease_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_documents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
          {
            foreignKeyName: "lease_field_confidence_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_governance_audit: {
        Row: {
          actor_email: string | null
          actor_user_id: string | null
          cancellation_reason: string | null
          change_summary: string | null
          created_at: string
          event_type: string
          field_label: string | null
          field_name: string | null
          final_value: string | null
          id: string
          lease_id: string
          old_value: string | null
          proposed_value: string | null
          rejection_reason: string | null
          related_change_set_id: string | null
          related_unlock_request_id: string | null
          workspace_id: string
        }
        Insert: {
          actor_email?: string | null
          actor_user_id?: string | null
          cancellation_reason?: string | null
          change_summary?: string | null
          created_at?: string
          event_type: string
          field_label?: string | null
          field_name?: string | null
          final_value?: string | null
          id?: string
          lease_id: string
          old_value?: string | null
          proposed_value?: string | null
          rejection_reason?: string | null
          related_change_set_id?: string | null
          related_unlock_request_id?: string | null
          workspace_id: string
        }
        Update: {
          actor_email?: string | null
          actor_user_id?: string | null
          cancellation_reason?: string | null
          change_summary?: string | null
          created_at?: string
          event_type?: string
          field_label?: string | null
          field_name?: string | null
          final_value?: string | null
          id?: string
          lease_id?: string
          old_value?: string | null
          proposed_value?: string | null
          rejection_reason?: string | null
          related_change_set_id?: string | null
          related_unlock_request_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_governance_audit_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_related_change_set_id_fkey"
            columns: ["related_change_set_id"]
            isOneToOne: false
            referencedRelation: "lease_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_related_unlock_request_id_fkey"
            columns: ["related_unlock_request_id"]
            isOneToOne: false
            referencedRelation: "lease_unlock_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
          {
            foreignKeyName: "lease_notifications_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
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
          {
            foreignKeyName: "lease_nudges_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_state_transitions: {
        Row: {
          created_at: string | null
          from_lifecycle: string | null
          from_status: string | null
          id: string
          lease_id: string
          metadata: Json | null
          to_lifecycle: string | null
          to_status: string
          transition_reason: string | null
          transitioned_by: string | null
        }
        Insert: {
          created_at?: string | null
          from_lifecycle?: string | null
          from_status?: string | null
          id?: string
          lease_id: string
          metadata?: Json | null
          to_lifecycle?: string | null
          to_status: string
          transition_reason?: string | null
          transitioned_by?: string | null
        }
        Update: {
          created_at?: string | null
          from_lifecycle?: string | null
          from_status?: string | null
          id?: string
          lease_id?: string
          metadata?: Json | null
          to_lifecycle?: string | null
          to_status?: string
          transition_reason?: string | null
          transitioned_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lease_state_transitions_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_state_transitions_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      lease_unlock_requests: {
        Row: {
          created_at: string
          id: string
          lease_id: string
          request_reason: string
          requested_by: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          lease_id: string
          request_reason: string
          requested_by: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          lease_id?: string
          request_reason?: string
          requested_by?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lease_unlock_requests_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_unlock_requests_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_unlock_requests_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      leases: {
        Row: {
          activated_at: string | null
          approver_email: string | null
          archived: boolean
          archived_at: string | null
          archived_by: string | null
          asset_type: string | null
          audit_log: Json | null
          avg_confidence_score: number | null
          base_rent_amount: string | null
          base_rent_frequency: string | null
          building: string | null
          business_unit: string | null
          calc_cash_pl_delta: number | null
          calc_pv_liability: number | null
          calc_straight_line_exp: number | null
          calc_total_commitment: number | null
          category: string | null
          concept_approved_at: string | null
          confidence_scores: Json | null
          confirmed_sections: string[]
          counter_signature_due_date: string | null
          counter_signature_reminder_count: number
          counter_signed_at: string | null
          covenant_flagged: boolean | null
          current_monthly_rent: number | null
          error_message: string | null
          escalation_clauses: string | null
          escalation_rate: number | null
          escalation_type: string | null
          estimated_monthly_cost_max: number | null
          estimated_monthly_cost_min: number | null
          estimated_term_max: number | null
          estimated_term_min: number | null
          executed_break_clause: string | null
          executed_commencement_date: string | null
          executed_document_url: string | null
          executed_expiry_date: string | null
          executed_extracted_json: Json | null
          executed_extraction_confidence: Json | null
          executed_filename: string | null
          executed_landlord_name: string | null
          executed_monthly_payment: number | null
          executed_rent_review_clause: string | null
          executed_storage_path: string | null
          executed_tenant_name: string | null
          executed_uploaded_at: string | null
          executed_uploaded_by: string | null
          execution_approved_at: string | null
          execution_owner_id: string | null
          expected_start_date: string | null
          extracted_json: Json | null
          filename: string
          financial_approved_at: string | null
          financial_approved_by: string | null
          financial_rejection_reason: string | null
          financial_returned_to_submitter: boolean | null
          fully_executed_at: string | null
          id: string
          initializer_id: string | null
          intake_source: string | null
          internal_approved_at: string | null
          landlord_name: string | null
          last_nudged_at: string | null
          lease_classification: string | null
          lease_classification_set_at: string | null
          lease_classification_set_by: string | null
          lease_end: string | null
          lease_owner_id: string | null
          lease_start: string | null
          lease_type: string | null
          lifecycle_status: string | null
          location: string | null
          manager_approved_at: string | null
          manager_approved_by: string | null
          manager_rejection_reason: string | null
          model_locked: boolean
          model_locked_at: string | null
          model_locked_by: string | null
          monthly_payment: number | null
          needs_escalation_review: boolean | null
          notes: string | null
          parent_lease_id: string | null
          processed_at: string | null
          property_address: string | null
          region: string | null
          rejection_reason: string | null
          renewal_options: string | null
          rent_commencement_date: string | null
          rent_escalation_type: string | null
          request_description: string | null
          request_title: string | null
          request_urgency: string | null
          requesting_department: string | null
          requestor_id: string | null
          security_deposit: string | null
          signator_approved_at: string | null
          signator_attestation: string | null
          square_footage: number | null
          status: string
          status_changed_at: string | null
          storage_path: string | null
          submitted_for_approval_at: string | null
          summary_last_viewed_at: string | null
          summary_share_token: string | null
          summary_share_token_expires_at: string | null
          summary_shared_at: string | null
          tenant_name: string | null
          term_months: number | null
          termination_clauses: string | null
          unlock_action_token: string | null
          unlock_requested: boolean
          unlock_requested_at: string | null
          unlock_requested_by: string | null
          unlock_token_expires_at: string | null
          uploaded_at: string
          user_id: string
          variance_commencement_days: number | null
          variance_expiry_days: number | null
          variance_landlord_name_match: boolean | null
          variance_monthly_payment: number | null
          variance_reviewed_at: string | null
          variance_reviewed_by: string | null
          variance_tenant_name_match: boolean | null
          vendor_address_line1: string | null
          vendor_address_line2: string | null
          vendor_city: string | null
          vendor_name: string | null
          vendor_phone: string | null
          vendor_state: string | null
          vendor_zip: string | null
          workspace_id: string | null
        }
        Insert: {
          activated_at?: string | null
          approver_email?: string | null
          archived?: boolean
          archived_at?: string | null
          archived_by?: string | null
          asset_type?: string | null
          audit_log?: Json | null
          avg_confidence_score?: number | null
          base_rent_amount?: string | null
          base_rent_frequency?: string | null
          building?: string | null
          business_unit?: string | null
          calc_cash_pl_delta?: number | null
          calc_pv_liability?: number | null
          calc_straight_line_exp?: number | null
          calc_total_commitment?: number | null
          category?: string | null
          concept_approved_at?: string | null
          confidence_scores?: Json | null
          confirmed_sections?: string[]
          counter_signature_due_date?: string | null
          counter_signature_reminder_count?: number
          counter_signed_at?: string | null
          covenant_flagged?: boolean | null
          current_monthly_rent?: number | null
          error_message?: string | null
          escalation_clauses?: string | null
          escalation_rate?: number | null
          escalation_type?: string | null
          estimated_monthly_cost_max?: number | null
          estimated_monthly_cost_min?: number | null
          estimated_term_max?: number | null
          estimated_term_min?: number | null
          executed_break_clause?: string | null
          executed_commencement_date?: string | null
          executed_document_url?: string | null
          executed_expiry_date?: string | null
          executed_extracted_json?: Json | null
          executed_extraction_confidence?: Json | null
          executed_filename?: string | null
          executed_landlord_name?: string | null
          executed_monthly_payment?: number | null
          executed_rent_review_clause?: string | null
          executed_storage_path?: string | null
          executed_tenant_name?: string | null
          executed_uploaded_at?: string | null
          executed_uploaded_by?: string | null
          execution_approved_at?: string | null
          execution_owner_id?: string | null
          expected_start_date?: string | null
          extracted_json?: Json | null
          filename: string
          financial_approved_at?: string | null
          financial_approved_by?: string | null
          financial_rejection_reason?: string | null
          financial_returned_to_submitter?: boolean | null
          fully_executed_at?: string | null
          id?: string
          initializer_id?: string | null
          intake_source?: string | null
          internal_approved_at?: string | null
          landlord_name?: string | null
          last_nudged_at?: string | null
          lease_classification?: string | null
          lease_classification_set_at?: string | null
          lease_classification_set_by?: string | null
          lease_end?: string | null
          lease_owner_id?: string | null
          lease_start?: string | null
          lease_type?: string | null
          lifecycle_status?: string | null
          location?: string | null
          manager_approved_at?: string | null
          manager_approved_by?: string | null
          manager_rejection_reason?: string | null
          model_locked?: boolean
          model_locked_at?: string | null
          model_locked_by?: string | null
          monthly_payment?: number | null
          needs_escalation_review?: boolean | null
          notes?: string | null
          parent_lease_id?: string | null
          processed_at?: string | null
          property_address?: string | null
          region?: string | null
          rejection_reason?: string | null
          renewal_options?: string | null
          rent_commencement_date?: string | null
          rent_escalation_type?: string | null
          request_description?: string | null
          request_title?: string | null
          request_urgency?: string | null
          requesting_department?: string | null
          requestor_id?: string | null
          security_deposit?: string | null
          signator_approved_at?: string | null
          signator_attestation?: string | null
          square_footage?: number | null
          status?: string
          status_changed_at?: string | null
          storage_path?: string | null
          submitted_for_approval_at?: string | null
          summary_last_viewed_at?: string | null
          summary_share_token?: string | null
          summary_share_token_expires_at?: string | null
          summary_shared_at?: string | null
          tenant_name?: string | null
          term_months?: number | null
          termination_clauses?: string | null
          unlock_action_token?: string | null
          unlock_requested?: boolean
          unlock_requested_at?: string | null
          unlock_requested_by?: string | null
          unlock_token_expires_at?: string | null
          uploaded_at?: string
          user_id: string
          variance_commencement_days?: number | null
          variance_expiry_days?: number | null
          variance_landlord_name_match?: boolean | null
          variance_monthly_payment?: number | null
          variance_reviewed_at?: string | null
          variance_reviewed_by?: string | null
          variance_tenant_name_match?: boolean | null
          vendor_address_line1?: string | null
          vendor_address_line2?: string | null
          vendor_city?: string | null
          vendor_name?: string | null
          vendor_phone?: string | null
          vendor_state?: string | null
          vendor_zip?: string | null
          workspace_id?: string | null
        }
        Update: {
          activated_at?: string | null
          approver_email?: string | null
          archived?: boolean
          archived_at?: string | null
          archived_by?: string | null
          asset_type?: string | null
          audit_log?: Json | null
          avg_confidence_score?: number | null
          base_rent_amount?: string | null
          base_rent_frequency?: string | null
          building?: string | null
          business_unit?: string | null
          calc_cash_pl_delta?: number | null
          calc_pv_liability?: number | null
          calc_straight_line_exp?: number | null
          calc_total_commitment?: number | null
          category?: string | null
          concept_approved_at?: string | null
          confidence_scores?: Json | null
          confirmed_sections?: string[]
          counter_signature_due_date?: string | null
          counter_signature_reminder_count?: number
          counter_signed_at?: string | null
          covenant_flagged?: boolean | null
          current_monthly_rent?: number | null
          error_message?: string | null
          escalation_clauses?: string | null
          escalation_rate?: number | null
          escalation_type?: string | null
          estimated_monthly_cost_max?: number | null
          estimated_monthly_cost_min?: number | null
          estimated_term_max?: number | null
          estimated_term_min?: number | null
          executed_break_clause?: string | null
          executed_commencement_date?: string | null
          executed_document_url?: string | null
          executed_expiry_date?: string | null
          executed_extracted_json?: Json | null
          executed_extraction_confidence?: Json | null
          executed_filename?: string | null
          executed_landlord_name?: string | null
          executed_monthly_payment?: number | null
          executed_rent_review_clause?: string | null
          executed_storage_path?: string | null
          executed_tenant_name?: string | null
          executed_uploaded_at?: string | null
          executed_uploaded_by?: string | null
          execution_approved_at?: string | null
          execution_owner_id?: string | null
          expected_start_date?: string | null
          extracted_json?: Json | null
          filename?: string
          financial_approved_at?: string | null
          financial_approved_by?: string | null
          financial_rejection_reason?: string | null
          financial_returned_to_submitter?: boolean | null
          fully_executed_at?: string | null
          id?: string
          initializer_id?: string | null
          intake_source?: string | null
          internal_approved_at?: string | null
          landlord_name?: string | null
          last_nudged_at?: string | null
          lease_classification?: string | null
          lease_classification_set_at?: string | null
          lease_classification_set_by?: string | null
          lease_end?: string | null
          lease_owner_id?: string | null
          lease_start?: string | null
          lease_type?: string | null
          lifecycle_status?: string | null
          location?: string | null
          manager_approved_at?: string | null
          manager_approved_by?: string | null
          manager_rejection_reason?: string | null
          model_locked?: boolean
          model_locked_at?: string | null
          model_locked_by?: string | null
          monthly_payment?: number | null
          needs_escalation_review?: boolean | null
          notes?: string | null
          parent_lease_id?: string | null
          processed_at?: string | null
          property_address?: string | null
          region?: string | null
          rejection_reason?: string | null
          renewal_options?: string | null
          rent_commencement_date?: string | null
          rent_escalation_type?: string | null
          request_description?: string | null
          request_title?: string | null
          request_urgency?: string | null
          requesting_department?: string | null
          requestor_id?: string | null
          security_deposit?: string | null
          signator_approved_at?: string | null
          signator_attestation?: string | null
          square_footage?: number | null
          status?: string
          status_changed_at?: string | null
          storage_path?: string | null
          submitted_for_approval_at?: string | null
          summary_last_viewed_at?: string | null
          summary_share_token?: string | null
          summary_share_token_expires_at?: string | null
          summary_shared_at?: string | null
          tenant_name?: string | null
          term_months?: number | null
          termination_clauses?: string | null
          unlock_action_token?: string | null
          unlock_requested?: boolean
          unlock_requested_at?: string | null
          unlock_requested_by?: string | null
          unlock_token_expires_at?: string | null
          uploaded_at?: string
          user_id?: string
          variance_commencement_days?: number | null
          variance_expiry_days?: number | null
          variance_landlord_name_match?: boolean | null
          variance_monthly_payment?: number | null
          variance_reviewed_at?: string | null
          variance_reviewed_by?: string | null
          variance_tenant_name_match?: boolean | null
          vendor_address_line1?: string | null
          vendor_address_line2?: string | null
          vendor_city?: string | null
          vendor_name?: string | null
          vendor_phone?: string | null
          vendor_state?: string | null
          vendor_zip?: string | null
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
            foreignKeyName: "leases_parent_lease_id_fkey"
            columns: ["parent_lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
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
      notifications: {
        Row: {
          alert_type: string
          body: string
          created_at: string
          id: string
          lease_id: string | null
          read_at: string | null
          title: string
          user_id: string | null
          workspace_id: string
        }
        Insert: {
          alert_type: string
          body: string
          created_at?: string
          id?: string
          lease_id?: string | null
          read_at?: string | null
          title: string
          user_id?: string | null
          workspace_id: string
        }
        Update: {
          alert_type?: string
          body?: string
          created_at?: string
          id?: string
          lease_id?: string | null
          read_at?: string | null
          title?: string
          user_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      processing_rate_limits: {
        Row: {
          created_at: string
          function_name: string
          id: string
          request_count: number
          updated_at: string
          window_start: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          function_name: string
          id?: string
          request_count?: number
          updated_at?: string
          window_start: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          function_name?: string
          id?: string
          request_count?: number
          updated_at?: string
          window_start?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_rate_limits_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          ai_processing_consent_at: string | null
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
          ai_processing_consent_at?: string | null
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
          ai_processing_consent_at?: string | null
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
          {
            foreignKeyName: "rent_schedules_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_templates: {
        Row: {
          asset_type: string | null
          created_at: string
          created_by: string | null
          default_explanation: string
          id: string
          is_system: boolean
          severity: string
          title: string
          workspace_id: string | null
        }
        Insert: {
          asset_type?: string | null
          created_at?: string
          created_by?: string | null
          default_explanation: string
          id?: string
          is_system?: boolean
          severity: string
          title: string
          workspace_id?: string | null
        }
        Update: {
          asset_type?: string | null
          created_at?: string
          created_by?: string | null
          default_explanation?: string
          id?: string
          is_system?: boolean
          severity?: string
          title?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "risk_templates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      risks: {
        Row: {
          citation_page: number | null
          citation_snippet: string | null
          created_by: string | null
          dismissed_at: string | null
          dismissed_by: string | null
          dismissed_reason: string | null
          explanation: string | null
          id: string
          is_user_added: boolean
          lease_id: string
          risk_template_id: string | null
          severity: string
          source_text_norm: string | null
          title: string
        }
        Insert: {
          citation_page?: number | null
          citation_snippet?: string | null
          created_by?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          dismissed_reason?: string | null
          explanation?: string | null
          id?: string
          is_user_added?: boolean
          lease_id: string
          risk_template_id?: string | null
          severity: string
          source_text_norm?: string | null
          title: string
        }
        Update: {
          citation_page?: number | null
          citation_snippet?: string | null
          created_by?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          dismissed_reason?: string | null
          explanation?: string | null
          id?: string
          is_user_added?: boolean
          lease_id?: string
          risk_template_id?: string | null
          severity?: string
          source_text_norm?: string | null
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
          {
            foreignKeyName: "risks_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risks_risk_template_id_fkey"
            columns: ["risk_template_id"]
            isOneToOne: false
            referencedRelation: "risk_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      summary_views: {
        Row: {
          id: string
          lease_id: string
          referrer: string | null
          viewed_at: string | null
          viewer_ip: string | null
        }
        Insert: {
          id?: string
          lease_id: string
          referrer?: string | null
          viewed_at?: string | null
          viewer_ip?: string | null
        }
        Update: {
          id?: string
          lease_id?: string
          referrer?: string | null
          viewed_at?: string | null
          viewer_ip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "summary_views_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "summary_views_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string
          id: string
          onboarding_dismissed_at: string | null
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          onboarding_dismissed_at?: string | null
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          onboarding_dismissed_at?: string | null
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
      workspace_roles: {
        Row: {
          created_at: string | null
          id: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_roles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          approval_threshold: number | null
          asset_type_config: Json | null
          backdoor_enabled: boolean
          billing_interval: string
          building_options: Json
          counter_signature_default_due_days: number
          covenant_threshold: number | null
          created_at: string
          default_notification_days: number
          department_options: Json
          discount_rate: number | null
          document_limit: number
          documents_used: number
          id: string
          location_options: Json
          max_archived_leases: number | null
          name: string
          owner_id: string
          plan: string
          region_options: Json
          separation_of_duties_default: boolean
          timezone: string
          updated_at: string
        }
        Insert: {
          approval_threshold?: number | null
          asset_type_config?: Json | null
          backdoor_enabled?: boolean
          billing_interval?: string
          building_options?: Json
          counter_signature_default_due_days?: number
          covenant_threshold?: number | null
          created_at?: string
          default_notification_days?: number
          department_options?: Json
          discount_rate?: number | null
          document_limit?: number
          documents_used?: number
          id?: string
          location_options?: Json
          max_archived_leases?: number | null
          name: string
          owner_id: string
          plan?: string
          region_options?: Json
          separation_of_duties_default?: boolean
          timezone?: string
          updated_at?: string
        }
        Update: {
          approval_threshold?: number | null
          asset_type_config?: Json | null
          backdoor_enabled?: boolean
          billing_interval?: string
          building_options?: Json
          counter_signature_default_due_days?: number
          covenant_threshold?: number | null
          created_at?: string
          default_notification_days?: number
          department_options?: Json
          discount_rate?: number | null
          document_limit?: number
          documents_used?: number
          id?: string
          location_options?: Json
          max_archived_leases?: number | null
          name?: string
          owner_id?: string
          plan?: string
          region_options?: Json
          separation_of_duties_default?: boolean
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      v_correction_analytics: {
        Row: {
          avg_original_confidence: number | null
          field_name: string | null
          last_correction: string | null
          leases_affected: number | null
          total_corrections: number | null
        }
        Relationships: []
      }
      v_governance_audit_report: {
        Row: {
          actor_email: string | null
          actor_user_id: string | null
          cancellation_reason: string | null
          change_summary: string | null
          event_timestamp: string | null
          event_type: string | null
          field_label: string | null
          field_name: string | null
          final_value: string | null
          id: string | null
          lease_id: string | null
          lease_name: string | null
          old_value: string | null
          proposed_value: string | null
          rejection_reason: string | null
          related_change_set_id: string | null
          related_unlock_request_id: string | null
          workspace_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lease_governance_audit_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "leases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_lease_id_fkey"
            columns: ["lease_id"]
            isOneToOne: false
            referencedRelation: "v_review_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_related_change_set_id_fkey"
            columns: ["related_change_set_id"]
            isOneToOne: false
            referencedRelation: "lease_change_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_related_unlock_request_id_fkey"
            columns: ["related_unlock_request_id"]
            isOneToOne: false
            referencedRelation: "lease_unlock_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lease_governance_audit_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      v_review_queue: {
        Row: {
          avg_confidence_score: number | null
          fields_requiring_review: string[] | null
          filename: string | null
          id: string | null
          landlord_name: string | null
          review_field_count: number | null
          status: string | null
          tenant_name: string | null
          uploaded_at: string | null
          user_id: string | null
          workspace_id: string | null
        }
        Insert: {
          avg_confidence_score?: number | null
          fields_requiring_review?: never
          filename?: string | null
          id?: string | null
          landlord_name?: string | null
          review_field_count?: never
          status?: string | null
          tenant_name?: string | null
          uploaded_at?: string | null
          user_id?: string | null
          workspace_id?: string | null
        }
        Update: {
          avg_confidence_score?: number | null
          fields_requiring_review?: never
          filename?: string | null
          id?: string | null
          landlord_name?: string | null
          review_field_count?: never
          status?: string | null
          tenant_name?: string | null
          uploaded_at?: string | null
          user_id?: string | null
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
    }
    Functions: {
      apply_policy_steps: {
        Args: { p_policy_id: string; p_steps: Json }
        Returns: undefined
      }
      approve_field: {
        Args: { p_field_name: string; p_lease_id: string }
        Returns: boolean
      }
      finalize_lease_approval: {
        Args: { p_lease_id: string }
        Returns: boolean
      }
      get_audit_user_id: { Args: { p_email: string }; Returns: string }
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
      preview_policy_resolution: {
        Args: {
          p_annual_cost: number
          p_asset_type: string
          p_department: string
          p_lease_type: string
          p_region: string
          p_workspace_id: string
        }
        Returns: Json
      }
      record_field_correction: {
        Args: {
          p_corrected_value: string
          p_correction_type?: string
          p_field_name: string
          p_lease_id: string
          p_original_value: string
          p_user_notes?: string
        }
        Returns: string
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
