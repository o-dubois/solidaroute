/**
 * Terms of Service page — /terms
 *
 * Public page (no auth required). Bilingual content rendered based on the
 * current i18n language.
 *
 * NOTE: This is a template. Have it reviewed by a legal professional before
 * going live, and update the organization name and contact details.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAppConfig } from '../context/AppConfigContext';

const YEAR = new Date().getFullYear();

export default function TermsOfService() {
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
          {fr ? 'Conditions d\'utilisation' : 'Terms of Service'}
        </h1>
        <p className="text-sm text-gray-400 mb-8">
          {fr ? `Dernière mise à jour : ${YEAR}` : `Last updated: ${YEAR}`}
        </p>

        {fr ? <FrenchContent appName={appName} /> : <EnglishContent appName={appName} />}

        <div className="mt-10 pt-6 border-t border-gray-100 dark:border-gray-700 flex gap-4 text-sm text-gray-400">
          <Link to="/privacy" className="hover:text-teal-600 transition-colors">
            {fr ? 'Politique de confidentialité' : 'Privacy Policy'}
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
      <Section title="1. Acceptation des conditions">
        <p>En utilisant la plateforme {appName}, vous acceptez les présentes conditions d'utilisation. Si vous n'acceptez pas ces conditions, veuillez ne pas utiliser la plateforme.</p>
      </Section>

      <Section title="2. Description du service">
        <p>{appName} est une plateforme communautaire qui facilite la mise en relation entre des personnes ayant besoin de transport (usagers) et des conducteurs bénévoles. {appName} agit à titre de coordonnateur et n'est pas un service de taxi, de transport rémunéré ou de covoiturage commercial.</p>
      </Section>

      <Section title="3. Responsabilités des usagers">
        <ul className="list-disc pl-5 space-y-1">
          <li>Fournir des informations exactes lors de l'inscription et des réservations</li>
          <li>Se présenter aux rendez-vous confirmés ou annuler dans un délai raisonnable</li>
          <li>Traiter les conducteurs bénévoles avec respect</li>
          <li>Ne pas utiliser la plateforme à des fins illicites ou abusives</li>
        </ul>
      </Section>

      <Section title="4. Responsabilités des conducteurs bénévoles">
        <ul className="list-disc pl-5 space-y-1">
          <li>Détenir un permis de conduire valide et une assurance automobile en règle</li>
          <li>Maintenir leur véhicule en bon état de marche et sécuritaire</li>
          <li>Respecter le Code de la sécurité routière du Québec</li>
          <li>Traiter les usagers avec respect et confidentialité</li>
          <li>Ne pas exiger de rémunération au-delà des frais convenus sur la plateforme</li>
        </ul>
      </Section>

      <Section title="5. Limitation de responsabilité">
        <p>{appName} agit uniquement comme intermédiaire de coordination. La plateforme n'est pas responsable des accidents, incidents, retards, annulations ou tout dommage survenant dans le cadre des trajets. Les conducteurs bénévoles agissent en leur propre nom et sous leur propre responsabilité. L'utilisation de la plateforme est à vos risques et périls.</p>
      </Section>

      <Section title="6. Paiements et remboursements">
        <p>Les frais de transport sont calculés automatiquement selon la distance et les paramètres configurés par l'administrateur. Les paiements par carte sont traités de façon sécurisée par Stripe. En cas d'annulation, contactez l'administrateur pour toute demande de remboursement.</p>
      </Section>

      <Section title="7. Suspension et résiliation de compte">
        <p>{appName} se réserve le droit de suspendre ou de résilier tout compte en cas de violation des présentes conditions, de comportement abusif ou de fraude. Vous pouvez supprimer votre compte à tout moment depuis votre profil.</p>
      </Section>

      <Section title="8. Modifications des conditions">
        <p>Nous pouvons modifier les présentes conditions à tout moment. Les modifications entrent en vigueur dès leur publication sur la plateforme. L'utilisation continue du service après modification vaut acceptation des nouvelles conditions.</p>
      </Section>

      <Section title="9. Droit applicable">
        <p>Les présentes conditions sont régies par les lois de la province de Québec et du Canada. Tout litige sera soumis aux tribunaux compétents du Québec.</p>
      </Section>

      <Section title="10. Contact">
        <p>Pour toute question concernant ces conditions : <strong>contact@solidaroute.ca</strong></p>
      </Section>
    </>
  );
}

function EnglishContent({ appName }) {
  return (
    <>
      <Section title="1. Acceptance of terms">
        <p>By using the {appName} platform, you agree to these Terms of Service. If you do not agree, please do not use the platform.</p>
      </Section>

      <Section title="2. Service description">
        <p>{appName} is a community platform that connects people who need transportation (riders) with volunteer drivers. {appName} acts as a coordinator only and is not a taxi service, paid transportation service, or commercial ridesharing company.</p>
      </Section>

      <Section title="3. Rider responsibilities">
        <ul className="list-disc pl-5 space-y-1">
          <li>Provide accurate information during registration and when booking trips</li>
          <li>Be present at confirmed pickup points or cancel with reasonable notice</li>
          <li>Treat volunteer drivers with respect</li>
          <li>Not use the platform for unlawful or abusive purposes</li>
        </ul>
      </Section>

      <Section title="4. Volunteer driver responsibilities">
        <ul className="list-disc pl-5 space-y-1">
          <li>Hold a valid driver's license and maintain proper automobile insurance</li>
          <li>Keep their vehicle in a safe and roadworthy condition</li>
          <li>Comply with the Quebec Highway Safety Code</li>
          <li>Treat riders with respect and maintain confidentiality</li>
          <li>Not demand payment beyond the fees agreed upon through the platform</li>
        </ul>
      </Section>

      <Section title="5. Limitation of liability">
        <p>{appName} acts solely as a coordination intermediary. The platform is not responsible for accidents, incidents, delays, cancellations, or any damages occurring during trips. Volunteer drivers act on their own behalf and under their own responsibility. Use of the platform is at your own risk.</p>
      </Section>

      <Section title="6. Payments and refunds">
        <p>Transportation fees are calculated automatically based on distance and administrator-configured pricing. Card payments are processed securely by Stripe. For cancellation refunds, please contact the administrator.</p>
      </Section>

      <Section title="7. Account suspension and termination">
        <p>{appName} reserves the right to suspend or terminate any account for violation of these terms, abusive behaviour, or fraud. You may delete your account at any time from your profile page.</p>
      </Section>

      <Section title="8. Changes to these terms">
        <p>We may update these terms at any time. Changes take effect upon publication on the platform. Continued use of the service after changes constitutes acceptance of the new terms.</p>
      </Section>

      <Section title="9. Governing law">
        <p>These terms are governed by the laws of the Province of Quebec and Canada. Any disputes shall be submitted to the competent courts of Quebec.</p>
      </Section>

      <Section title="10. Contact">
        <p>For any questions about these terms: <strong>contact@solidaroute.ca</strong></p>
      </Section>
    </>
  );
}
