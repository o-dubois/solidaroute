import { useTranslation } from 'react-i18next';
// TODO: Implement full TripDetail
export default function TripDetail() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="mb-6">{t('trips.title')}</h1>
      <div className="card text-gray-500 dark:text-gray-400 text-sm">Component under construction — TripDetail</div>
    </div>
  );
}
