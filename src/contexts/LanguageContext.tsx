import React, { createContext, useContext, useState, ReactNode } from 'react';

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
    
    // Dashboard
    'dashboard.welcome_back': 'Welcome back',
    'dashboard.upload_lease': 'Upload Lease',
    'dashboard.active_leases': 'Active Leases',
    'dashboard.action_required': 'Action Required',
    'dashboard.expiring_90_days': 'Expiring in 90 Days',
    'dashboard.finalized': 'Finalized',
    'dashboard.total_monthly_rent': 'Total Monthly Rent',
    'dashboard.annual_obligation': 'Annual Obligation',
    'dashboard.next_payment_due': 'Next Payment Due',
    'dashboard.rent_per_lease': 'Rent Per Lease',
    'dashboard.active_lease': 'active lease',
    'dashboard.active_leases_count': 'active leases',
    'dashboard.total_for_year': 'Total for the year',
    'dashboard.no_upcoming_payments': 'No upcoming payments',
    'dashboard.average_monthly': 'Average monthly',
    'dashboard.days': 'days',
    'dashboard.upcoming_events': 'Upcoming Events',
    'dashboard.view_all': 'View all',
    'dashboard.no_upcoming_events': 'No upcoming events',
    'dashboard.events_appear_here': 'Events will appear here as your leases approach key dates',
    'dashboard.today': 'Today',
    'dashboard.tomorrow': 'Tomorrow',
    'dashboard.renewal': 'Renewal',
    'dashboard.escalation': 'Escalation',
    'dashboard.expiration': 'Expiration',
    'dashboard.payment': 'Payment',
    'dashboard.lease_expires': 'Lease expires',
    'dashboard.renewal_window_opens': 'Renewal window opens',
    'dashboard.rent_payment_due': 'Rent payment due',
    'dashboard.properties': 'properties',
    
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
    'lease.not_found': 'Lease not found',
    'lease.back_to_leases': 'Back to Leases',
    
    // Leases Page
    'leases.title': 'Leases',
    'leases.portfolio': 'Your lease portfolio',
    'leases.search': 'Search leases...',
    'leases.filter_expiration': 'Filter by expiration',
    'leases.all_leases': 'All leases',
    'leases.expiring_30': 'Expiring in 30 days',
    'leases.expiring_90': 'Expiring in 90 days',
    'leases.expiring_year': 'Expiring this year',
    'leases.property': 'Property',
    'leases.tenant': 'Tenant',
    'leases.landlord': 'Landlord',
    'leases.dates': 'Dates',
    'leases.rent': 'Rent',
    'leases.actions': 'Actions',
    'leases.no_leases': 'No leases yet',
    'leases.upload_first': 'Upload your first lease to get started',
    
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
    
    // Notifications
    'notifications.title': 'Notifications',
    'notifications.subtitle': 'Stay on top of important dates',
    'notifications.no_notifications': 'No notifications',
    'notifications.all_caught_up': "You're all caught up!",
    
    // Settings
    'settings.workspace': 'Workspace Settings',
    'settings.account': 'Account Settings',
    'settings.profile': 'Profile',
    'settings.preferences': 'Preferences',
    'settings.billing': 'Billing',
    'settings.save_changes': 'Save Changes',
    'settings.first_name': 'First Name',
    'settings.last_name': 'Last Name',
    'settings.email': 'Email',
    'settings.company': 'Company Name',
    'settings.timezone': 'Timezone',
    
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
    'common.search': 'Search',
    'common.view': 'View',
    
    // Plan labels
    'plan.free': 'Free',
    'plan.starter': 'Starter',
    'plan.pro': 'Pro',
    'plan.business': 'Business',
    'plan.plan': 'Plan',
    'plan.upgrade': 'Upgrade',
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
    
    // Dashboard
    'dashboard.welcome_back': 'Bienvenido de nuevo',
    'dashboard.upload_lease': 'Subir Arrendamiento',
    'dashboard.active_leases': 'Arrendamientos Activos',
    'dashboard.action_required': 'Acción Requerida',
    'dashboard.expiring_90_days': 'Vencen en 90 Días',
    'dashboard.finalized': 'Finalizados',
    'dashboard.total_monthly_rent': 'Renta Mensual Total',
    'dashboard.annual_obligation': 'Obligación Anual',
    'dashboard.next_payment_due': 'Próximo Pago',
    'dashboard.rent_per_lease': 'Renta por Arrendamiento',
    'dashboard.active_lease': 'arrendamiento activo',
    'dashboard.active_leases_count': 'arrendamientos activos',
    'dashboard.total_for_year': 'Total del año',
    'dashboard.no_upcoming_payments': 'Sin pagos pendientes',
    'dashboard.average_monthly': 'Promedio mensual',
    'dashboard.days': 'días',
    'dashboard.upcoming_events': 'Próximos Eventos',
    'dashboard.view_all': 'Ver todos',
    'dashboard.no_upcoming_events': 'Sin eventos próximos',
    'dashboard.events_appear_here': 'Los eventos aparecerán aquí cuando sus arrendamientos se acerquen a fechas clave',
    'dashboard.today': 'Hoy',
    'dashboard.tomorrow': 'Mañana',
    'dashboard.renewal': 'Renovación',
    'dashboard.escalation': 'Escalación',
    'dashboard.expiration': 'Vencimiento',
    'dashboard.payment': 'Pago',
    'dashboard.lease_expires': 'Arrendamiento vence',
    'dashboard.renewal_window_opens': 'Ventana de renovación abre',
    'dashboard.rent_payment_due': 'Pago de renta pendiente',
    'dashboard.properties': 'propiedades',
    
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
    'lease.not_found': 'Arrendamiento no encontrado',
    'lease.back_to_leases': 'Volver a Arrendamientos',
    
    // Leases Page
    'leases.title': 'Arrendamientos',
    'leases.portfolio': 'Su portafolio de arrendamientos',
    'leases.search': 'Buscar arrendamientos...',
    'leases.filter_expiration': 'Filtrar por vencimiento',
    'leases.all_leases': 'Todos los arrendamientos',
    'leases.expiring_30': 'Vencen en 30 días',
    'leases.expiring_90': 'Vencen en 90 días',
    'leases.expiring_year': 'Vencen este año',
    'leases.property': 'Propiedad',
    'leases.tenant': 'Arrendatario',
    'leases.landlord': 'Arrendador',
    'leases.dates': 'Fechas',
    'leases.rent': 'Renta',
    'leases.actions': 'Acciones',
    'leases.no_leases': 'Sin arrendamientos',
    'leases.upload_first': 'Suba su primer arrendamiento para comenzar',
    
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
    
    // Notifications
    'notifications.title': 'Notificaciones',
    'notifications.subtitle': 'Manténgase al día con fechas importantes',
    'notifications.no_notifications': 'Sin notificaciones',
    'notifications.all_caught_up': '¡Está al día!',
    
    // Settings
    'settings.workspace': 'Configuración del Espacio de Trabajo',
    'settings.account': 'Configuración de Cuenta',
    'settings.profile': 'Perfil',
    'settings.preferences': 'Preferencias',
    'settings.billing': 'Facturación',
    'settings.save_changes': 'Guardar Cambios',
    'settings.first_name': 'Nombre',
    'settings.last_name': 'Apellido',
    'settings.email': 'Correo Electrónico',
    'settings.company': 'Nombre de la Empresa',
    'settings.timezone': 'Zona Horaria',
    
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
    'common.search': 'Buscar',
    'common.view': 'Ver',
    
    // Plan labels
    'plan.free': 'Gratis',
    'plan.starter': 'Inicial',
    'plan.pro': 'Pro',
    'plan.business': 'Empresarial',
    'plan.plan': 'Plan',
    'plan.upgrade': 'Actualizar',
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
