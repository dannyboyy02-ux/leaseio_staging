import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

type Language = 'en' | 'es';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
}

const translations: Record<Language, Record<string, string>> = {
  en: {
    // Navigation
    'nav.dashboard': 'Dashboard',
    'nav.leases': 'Leases',
    'nav.imports': 'Imports',
    'nav.reports': 'Reports',
    'nav.notifications': 'Notifications',
    'nav.integrations': 'Integrations',
    'nav.workspace': 'Workspace',
    'nav.account': 'Account',
    'nav.settings': 'Settings',
    'nav.documents': 'Documents',
    'nav.upgrade_for_more': 'Upgrade for more',
    'nav.account_settings': 'Account Settings',
    'nav.help_support': 'Help & Support',
    'nav.log_out': 'Log Out',
    
    // Lease Review
    'lease.review': 'Review Lease',
    'lease.parties': 'Parties',
    'lease.landlord': 'Landlord',
    'lease.tenant': 'Tenant',
    'lease.property_term': 'Property & Term',
    'lease.property_address': 'Property Address',
    'lease.commencement_date': 'Commencement Date',
    'lease.expiration_date': 'Expiration Date',
    'lease.rent_schedule': 'Rent Schedule',
    'lease.financial_terms': 'Additional Financial Terms',
    'lease.base_rent': 'Base Rent (Legacy)',
    'lease.rent_frequency': 'Rent Frequency',
    'lease.security_deposit': 'Security Deposit',
    'lease.escalation_clauses': 'Escalation Clauses (Description)',
    'lease.additional_terms': 'Additional Terms',
    'lease.renewal_options': 'Renewal Options',
    'lease.termination_clauses': 'Termination Clauses',
    'lease.key_dates': 'Key Dates & Notifications',
    'lease.document': 'Document',
    'lease.download_original': 'Download Original',
    'lease.identified_risks': 'Identified Risks',
    'lease.no_risks': 'No risks identified',
    'lease.status': 'Status',
    'lease.approve': 'Approve Lease',
    'lease.approved': 'Approved',
    'lease.active': 'Active',
    'lease.confirm': 'Confirm',
    'lease.edit': 'Edit',
    'lease.save': 'Save',
    'lease.back': 'Back',
    'lease.finalize': 'Finalize',
    'lease.review_required': 'Review Required',
    'lease.review_edit_info': 'Review and edit the extracted information below, then save your changes before finalizing.',
    'lease.finalized': 'Finalized',
    'lease.finalized_info': 'This lease has been reviewed and finalized.',
    'lease.approved_info': 'This lease has been approved and is now active.',
    'lease.processing': 'Processing',
    'lease.uploaded': 'Uploaded',
    'lease.ready': 'Ready',
    'lease.failed': 'Failed',
    'lease.ai_risks_desc': 'AI-identified potential issues in this lease',
    
    // Import History
    'import.history': 'Import History',
    'import.documents_imported': 'documents imported',
    'import.upload_lease': 'Upload Lease',
    'import.no_imports': 'No imports yet',
    'import.upload_first': 'Upload your first lease document to get started',
    'import.search_filename': 'Search by filename...',
    'import.filename': 'Filename',
    'import.uploaded': 'Uploaded',
    'import.processed': 'Processed',
    'import.actions': 'Actions',
    'import.retry': 'Retry',
    'import.view': 'View lease',
    'import.delete': 'Delete',
    
    // Common
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.edit': 'Edit',
    'common.delete': 'Delete',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.back': 'Back',
    'common.upload': 'Upload',
    'common.processing': 'Processing',
    'common.loading': 'Loading...',
    'common.page': 'Page',
    
    // Plan labels
    'plan.free': 'Free',
    'plan.starter': 'Starter',
    'plan.pro': 'Pro',
    'plan.business': 'Business',
  },
  es: {
    // Navigation
    'nav.dashboard': 'Panel',
    'nav.leases': 'Arrendamientos',
    'nav.imports': 'Importaciones',
    'nav.reports': 'Informes',
    'nav.notifications': 'Notificaciones',
    'nav.integrations': 'Integraciones',
    'nav.workspace': 'Espacio de Trabajo',
    'nav.account': 'Cuenta',
    'nav.settings': 'Configuración',
    'nav.documents': 'Documentos',
    'nav.upgrade_for_more': 'Actualizar para más',
    'nav.account_settings': 'Configuración de Cuenta',
    'nav.help_support': 'Ayuda y Soporte',
    'nav.log_out': 'Cerrar Sesión',
    
    // Lease Review
    'lease.review': 'Revisar Arrendamiento',
    'lease.parties': 'Partes',
    'lease.landlord': 'Arrendador',
    'lease.tenant': 'Arrendatario',
    'lease.property_term': 'Propiedad y Plazo',
    'lease.property_address': 'Dirección de la Propiedad',
    'lease.commencement_date': 'Fecha de Inicio',
    'lease.expiration_date': 'Fecha de Vencimiento',
    'lease.rent_schedule': 'Calendario de Renta',
    'lease.financial_terms': 'Términos Financieros Adicionales',
    'lease.base_rent': 'Renta Base (Legado)',
    'lease.rent_frequency': 'Frecuencia de Renta',
    'lease.security_deposit': 'Depósito de Seguridad',
    'lease.escalation_clauses': 'Cláusulas de Escalación (Descripción)',
    'lease.additional_terms': 'Términos Adicionales',
    'lease.renewal_options': 'Opciones de Renovación',
    'lease.termination_clauses': 'Cláusulas de Terminación',
    'lease.key_dates': 'Fechas Clave y Notificaciones',
    'lease.document': 'Documento',
    'lease.download_original': 'Descargar Original',
    'lease.identified_risks': 'Riesgos Identificados',
    'lease.no_risks': 'No se identificaron riesgos',
    'lease.status': 'Estado',
    'lease.approve': 'Aprobar Arrendamiento',
    'lease.approved': 'Aprobado',
    'lease.active': 'Activo',
    'lease.confirm': 'Confirmar',
    'lease.edit': 'Editar',
    'lease.save': 'Guardar',
    'lease.back': 'Volver',
    'lease.finalize': 'Finalizar',
    'lease.review_required': 'Revisión Requerida',
    'lease.review_edit_info': 'Revise y edite la información extraída a continuación, luego guarde sus cambios antes de finalizar.',
    'lease.finalized': 'Finalizado',
    'lease.finalized_info': 'Este arrendamiento ha sido revisado y finalizado.',
    'lease.approved_info': 'Este arrendamiento ha sido aprobado y ahora está activo.',
    'lease.processing': 'Procesando',
    'lease.uploaded': 'Subido',
    'lease.ready': 'Listo',
    'lease.failed': 'Fallido',
    'lease.ai_risks_desc': 'Problemas potenciales identificados por IA en este arrendamiento',
    
    // Import History
    'import.history': 'Historial de Importaciones',
    'import.documents_imported': 'documentos importados',
    'import.upload_lease': 'Subir Arrendamiento',
    'import.no_imports': 'Sin importaciones aún',
    'import.upload_first': 'Suba su primer documento de arrendamiento para comenzar',
    'import.search_filename': 'Buscar por nombre de archivo...',
    'import.filename': 'Nombre del Archivo',
    'import.uploaded': 'Subido',
    'import.processed': 'Procesado',
    'import.actions': 'Acciones',
    'import.retry': 'Reintentar',
    'import.view': 'Ver arrendamiento',
    'import.delete': 'Eliminar',
    
    // Common
    'common.confirm': 'Confirmar',
    'common.cancel': 'Cancelar',
    'common.save': 'Guardar',
    'common.edit': 'Editar',
    'common.delete': 'Eliminar',
    'common.yes': 'Sí',
    'common.no': 'No',
    'common.back': 'Volver',
    'common.upload': 'Subir',
    'common.processing': 'Procesando',
    'common.loading': 'Cargando...',
    'common.page': 'Página',
    
    // Plan labels
    'plan.free': 'Gratis',
    'plan.starter': 'Inicial',
    'plan.pro': 'Pro',
    'plan.business': 'Empresarial',
  },
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    const stored = localStorage.getItem('app-language');
    return (stored as Language) || 'en';
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('app-language', lang);
  };

  const t = (key: string): string => {
    return translations[language][key] || key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
