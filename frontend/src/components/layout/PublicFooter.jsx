/**
 * PublicFooter — copyright + legal links for public pages (Login, Register, etc.)
 * Mirrors the footer shown at the bottom of the authenticated sidebar.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppConfig } from '../../context/AppConfigContext';

export default function PublicFooter() {
  const { t } = useTranslation();
  const { appName } = useAppConfig();
  return (
    <div className="text-center mt-6 space-x-3 text-xs text-gray-300">
      <span>© {new Date().getFullYear()} {appName}</span>
      <span>·</span>
      <Link to="/privacy" target="_blank" className="hover:text-teal-500 transition-colors">
        {t('footer.privacy')}
      </Link>
      <span>·</span>
      <Link to="/terms" target="_blank" className="hover:text-teal-500 transition-colors">
        {t('footer.terms')}
      </Link>
    </div>
  );
}
