/**
 * Privacy Policy page — /privacy
 *
 * Public page (no auth required). Bilingual content rendered based on the
 * current i18n language. Covers Quebec Law 25 / Bill 64 requirements.
 *
 * NOTE: This is a template. Have it reviewed by a legal professional before
 * going live, and update the organization name, address, and contact email.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAppConfig } from '../context/AppConfigContext';

const YEAR = new Date().getFullYear();

export default function PrivacyPolicy() {
  const { i18n } = useTranslation();
  const { appName } = useAppConfig();
  const fr = i18n.language === 'fr';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-10 px-4">
      <div className="max-w-3xl mx-auto bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-8">

        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <span className="font-bold text-gray-900 dark:text-gray-50">{appName}</span>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-1">
          {fr ? 'Politique de confidentialité' : 'Privacy Policy'}
        </h1>
        <p className="text-sm text-gray-400 mb-8">
          {fr ? `Dernière mise à jour : ${YEAR}` : `Last updated: ${YEAR}`}
        </p>

        {fr ? <FrenchContent appName={appName} /> : <EnglishContent appName={appName} />}

        <div className="mt-10 pt-6 border-t border-gray-100 dark:border-gray-700 flex gap-4 text-sm text-gray-400">
          <Link to="/terms" className="hover:text-teal-600 transition-colors">
            {fr ? 'Conditions d\'utilisation' : 'Terms of Service'}
          </Link>
          <Link to="/login" className="hover:text-teal-600 transition-colors">
            {fr ? 'Retour à la connexion' : 'Back to login'}
          </Link>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-6">
      <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-2">{title}</h2>
      <div className="text-sm text-gray-600 dark:text-gray-300 space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}

function FrenchContent({ appName }) {
  return (
    <>
      <Section title="1. Qui sommes-nous ?">
        <p>{appName} est une plateforme communautaire de transport bénévole qui met en relation des personnes ayant besoin de transport avec des conducteurs bénévoles. Nos services sont offerts dans le respect de la <em>Loi sur la protection des renseignements personnels dans le secteur privé</em> (Loi 25) et du <em>Règlement général sur la protection des données</em> (RGPD).</p>
      </Section>

      <Section title="2. Renseignements collectés">
        <p>Nous collectons les renseignements personnels suivants :</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Compte :</strong> prénom, nom, adresse courriel, numéro de téléphone</li>
          <li><strong>Trajets :</strong> adresses de départ et d'arrivée, date et heure de départ</li>
          <li><strong>Conducteurs :</strong> informations sur le véhicule, adresse domicile (pour le rayon de service), documents (permis, assurance, immatriculation — chiffrés)</li>
          <li><strong>Paiements :</strong> méthode de paiement (traitée par Stripe — nous ne stockons pas les numéros de carte)</li>
        </ul>
      </Section>

      <Section title="3. Finalités du traitement">
        <p>Vos renseignements sont utilisés exclusivement pour :</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Coordonner les trajets entre clients et conducteurs bénévoles</li>
          <li>Traiter les paiements et générer les reçus</li>
          <li>Vous contacter au sujet de vos trajets (courriel, notifications)</li>
          <li>Assurer la sécurité de la plateforme et prévenir les abus</li>
        </ul>
      </Section>

      <Section title="4. Partage des renseignements">
        <p>Nous ne vendons ni ne louons vos renseignements personnels. Vos coordonnées (nom, téléphone) sont partagées uniquement avec le conducteur assigné à votre trajet, et vice versa. Les documents des conducteurs sont accessibles uniquement par les administrateurs de la plateforme.</p>
        <p>Nous faisons appel à des sous-traitants de confiance (Stripe pour les paiements, service SMTP pour les courriels) qui traitent vos données en notre nom, conformément à leur propre politique de confidentialité.</p>
      </Section>

      <Section title="5. Conservation des données">
        <p>Vos renseignements sont conservés tant que votre compte est actif. En cas de suppression de compte, vos données personnelles sont anonymisées conformément à nos politiques de rétention configurables par l'administrateur. Les journaux d'audit sont conservés à des fins légales et de sécurité.</p>
      </Section>

      <Section title="6. Vos droits">
        <p>Conformément à la Loi 25, vous avez le droit d'accéder à vos renseignements personnels, de les rectifier, de les faire supprimer et d'en retirer votre consentement. Vous pouvez exercer ces droits directement depuis votre profil ou en nous contactant à l'adresse ci-dessous.</p>
      </Section>

      <Section title="7. Sécurité">
        <p>Vos données sont stockées sur des serveurs sécurisés. Les documents sensibles (permis de conduire, assurance) sont chiffrés au repos (AES-256-GCM). Les mots de passe sont hachés avec bcrypt. Les communications sont sécurisées par HTTPS.</p>
      </Section>

      <Section title="8. Contact">
        <p>Pour toute question relative à la protection de vos renseignements personnels, veuillez nous contacter à : <strong>contact@solidaroute.ca</strong></p>
      </Section>
    </>
  );
}

function EnglishContent({ appName }) {
  return (
    <>
      <Section title="1. Who we are">
        <p>{appName} is a community volunteer transportation platform connecting people who need rides with volunteer drivers. Our services comply with Quebec's <em>Act respecting the protection of personal information in the private sector</em> (Law 25) and the <em>General Data Protection Regulation</em> (GDPR).</p>
      </Section>

      <Section title="2. Information we collect">
        <p>We collect the following personal information:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Account:</strong> first name, last name, email address, phone number</li>
          <li><strong>Trips:</strong> pickup and drop-off addresses, departure date and time</li>
          <li><strong>Drivers:</strong> vehicle details, home address (for service radius), documents (license, insurance, registration — encrypted)</li>
          <li><strong>Payments:</strong> payment method (processed by Stripe — we do not store card numbers)</li>
        </ul>
      </Section>

      <Section title="3. How we use your information">
        <p>Your information is used exclusively to:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Coordinate trips between clients and volunteer drivers</li>
          <li>Process payments and generate receipts</li>
          <li>Contact you about your trips (email, notifications)</li>
          <li>Ensure platform security and prevent abuse</li>
        </ul>
      </Section>

      <Section title="4. Sharing your information">
        <p>We do not sell or rent your personal information. Your contact details (name, phone) are shared only with the driver assigned to your trip, and vice versa. Driver documents are accessible only to platform administrators.</p>
        <p>We use trusted service providers (Stripe for payments, SMTP for email) who process your data on our behalf in accordance with their own privacy policies.</p>
      </Section>

      <Section title="5. Data retention">
        <p>Your information is retained for as long as your account is active. When an account is deleted, personal data is anonymized in accordance with our administrator-configured retention policies. Audit logs are retained for legal and security purposes.</p>
      </Section>

      <Section title="6. Your rights">
        <p>Under Law 25, you have the right to access, correct, delete, and withdraw consent for your personal information. You may exercise these rights directly from your profile page or by contacting us at the address below.</p>
      </Section>

      <Section title="7. Security">
        <p>Your data is stored on secure servers. Sensitive documents (driver's license, insurance) are encrypted at rest (AES-256-GCM). Passwords are hashed with bcrypt. All communications are secured via HTTPS.</p>
      </Section>

      <Section title="8. Contact">
        <p>For any questions about the protection of your personal information, please contact us at: <strong>contact@solidaroute.ca</strong></p>
      </Section>
    </>
  );
}
