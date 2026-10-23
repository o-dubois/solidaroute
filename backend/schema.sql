--
-- PostgreSQL database dump
--

\restrict sKfXj3FVLdbxbzBg9Md400LeLNPu8eBdAWvsPLvLt7tEWIXbOsjhQod8CdXdsCC

-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: completion_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.completion_source AS ENUM (
    'driver',
    'safeguard',
    'operator'
);


--
-- Name: driver_approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.driver_approval_status AS ENUM (
    'incomplete',
    'pending',
    'approved',
    'rejected',
    'suspended'
);


--
-- Name: earning_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.earning_status AS ENUM (
    'pending',
    'paid_out',
    'cancelled'
);


--
-- Name: frontend_language; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.frontend_language AS ENUM (
    'fr',
    'en',
    'both'
);


--
-- Name: notification_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel AS ENUM (
    'push',
    'sms',
    'email',
    'in_app'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'pending',
    'paid',
    'refunded',
    'failed',
    'authorized'
);


--
-- Name: token_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.token_type AS ENUM (
    'email_verification',
    'password_reset',
    'trip_action'
);


--
-- Name: trip_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.trip_status AS ENUM (
    'pending',
    'assigned',
    'in_progress',
    'completed',
    'cancelled'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'client',
    'driver',
    'operator',
    'superadmin',
    'ticket_master'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'pending',
    'active',
    'suspended',
    'deleted'
);


--
-- Name: vulnerability_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.vulnerability_type AS ENUM (
    'elderly',
    'hearing_impaired',
    'mild_disability',
    'no_drivers_license',
    'other'
);


--
-- Name: anonymize_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.anonymize_user(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_anon_id TEXT := 'deleted_' || REPLACE(p_user_id::TEXT, '-', '');
BEGIN
  UPDATE users SET
    email              = v_anon_id || '@deleted.local',
    password_hash      = '[DELETED]',
    first_name         = '[Deleted]',
    last_name          = '[Deleted]',
    phone              = NULL,
    status             = 'deleted',
    updated_at         = NOW()
  WHERE id = p_user_id;

  UPDATE client_profiles SET
    address                  = NULL,
    address_point            = NULL,
    emergency_contact_name   = NULL,
    emergency_contact_phone  = NULL,
    mobility_notes           = NULL,
    updated_at               = NOW()
  WHERE user_id = p_user_id;

  UPDATE driver_profiles SET
    home_address           = NULL,
    home_point             = ST_SetSRID(ST_MakePoint(0,0), 4326)::geography,
    license_plate          = '[DELETED]',
    updated_at             = NOW()
  WHERE user_id = p_user_id;

  DELETE FROM notifications WHERE user_id = p_user_id;

  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, new_state)
  VALUES (
    p_user_id, 'user.anonymized', 'user', p_user_id,
    '{"reason":"GDPR/Law25 deletion request"}'::jsonb
  );
END;
$$;


--
-- Name: available_drivers_near_trip(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.available_drivers_near_trip(p_trip_id uuid) RETURNS TABLE(driver_user_id uuid, full_name text, phone character varying, vehicle text, seat_count smallint, distance_km numeric, average_rating numeric, review_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.first_name || ' ' || u.last_name,
    u.phone,
    dp.vehicle_make || ' ' || dp.vehicle_model || ' ' || dp.vehicle_year::text,
    dp.seat_count,
    ROUND((ST_Distance(dp.home_point, t.pickup_point) / 1000)::numeric, 2),
    dp.average_rating,
    dp.review_count
  FROM trips t
  JOIN driver_profiles dp
    ON ST_DWithin(dp.home_point, t.pickup_point, dp.service_radius_km * 1000)
  JOIN users u ON u.id = dp.user_id
  WHERE t.id = p_trip_id
    AND dp.is_available         = TRUE
    AND dp.approval_status      = 'approved'
    AND u.status                = 'active'
    AND dp.seat_count           >= t.passenger_count
    AND NOT EXISTS (
      SELECT 1 FROM trips t2
      WHERE t2.driver_id = u.id
        AND t2.status IN ('assigned', 'in_progress')
        AND t2.departure_at < t.departure_at + INTERVAL '3 hours'
        AND t2.departure_at > t.departure_at - INTERVAL '3 hours'
    )
  ORDER BY distance_km ASC;
END;
$$;


--
-- Name: calculate_trip_cost(numeric, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_trip_cost(p_distance_km numeric, p_passenger_count integer) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_base_fare        NUMERIC := 2.50;
  v_per_km_rate      NUMERIC := 0.85;
  v_extra_passenger  NUMERIC := 0.50;
  v_total            NUMERIC;
BEGIN
  v_total := v_base_fare
           + (p_distance_km * v_per_km_rate)
           + (GREATEST(p_passenger_count - 1, 0) * v_extra_passenger);
  RETURN ROUND(v_total, 2);
END;
$$;


--
-- Name: FUNCTION calculate_trip_cost(p_distance_km numeric, p_passenger_count integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.calculate_trip_cost(p_distance_km numeric, p_passenger_count integer) IS 'Base: $2.50 + $0.85/km + $0.50 per extra passenger. Adjust rates in DECLARE block.';


--
-- Name: can_delete_user(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_delete_user(p_user_id uuid, p_by_admin boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_payment_count   INTEGER;
  v_account_age_days INTEGER;
  v_retention_days  INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_payment_count
  FROM payments pa
  JOIN trips t ON t.id = pa.trip_id
  WHERE (t.client_id = p_user_id OR t.driver_id = p_user_id)
    AND pa.status = 'paid';

  IF v_payment_count > 0 THEN
    RETURN jsonb_build_object(
      'can_delete', FALSE,
      'anonymize_only', TRUE,
      'reason', 'User has ' || v_payment_count ||
        ' payment(s) on record. Per Law 25 / GDPR, financial data must be retained. Account will be anonymized.'
    );
  END IF;

  IF p_by_admin THEN
    SELECT EXTRACT(DAY FROM NOW() - created_at)::INTEGER INTO v_account_age_days
    FROM users WHERE id = p_user_id;

    SELECT value::INTEGER INTO v_retention_days
    FROM configuration WHERE key = 'admin_deletion_retention_days';

    IF v_account_age_days < v_retention_days THEN
      RETURN jsonb_build_object(
        'can_delete', FALSE,
        'anonymize_only', FALSE,
        'reason', 'Account is only ' || v_account_age_days ||
          ' day(s) old. Minimum retention period is ' || v_retention_days || ' days.'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'can_delete', TRUE,
    'anonymize_only', FALSE,
    'reason', 'Deletion authorized'
  );
END;
$$;


--
-- Name: trigger_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_driver_rating(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_driver_rating() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_driver_user_id UUID;
BEGIN
  SELECT driver_id INTO v_driver_user_id
  FROM trips WHERE id = NEW.trip_id;

  IF v_driver_user_id IS NOT NULL
     AND NEW.reviewed_user_id = v_driver_user_id THEN
    UPDATE driver_profiles SET
      average_rating = (
        SELECT ROUND(AVG(rating)::numeric, 2)
        FROM reviews WHERE reviewed_user_id = v_driver_user_id
      ),
      review_count = (
        SELECT COUNT(*) FROM reviews
        WHERE reviewed_user_id = v_driver_user_id
      )
    WHERE user_id = v_driver_user_id;
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    actor_id uuid,
    action character varying(100) NOT NULL,
    entity_type character varying(80) NOT NULL,
    entity_id uuid,
    previous_state jsonb,
    new_state jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE audit_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.audit_logs IS 'Append only. Never update or delete rows here.';


--
-- Name: client_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    vulnerability_type public.vulnerability_type,
    address text,
    address_point public.geography(Point,4326),
    emergency_contact_name character varying(150),
    emergency_contact_phone character varying(20),
    mobility_notes text,
    preferred_language character varying(10) DEFAULT 'fr'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN client_profiles.vulnerability_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.vulnerability_type IS 'Optional — filled in profile, not at registration.';


--
-- Name: COLUMN client_profiles.address_point; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_profiles.address_point IS 'PostGIS geographic point for distance calculations.';


--
-- Name: config_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_change_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key character varying(100) NOT NULL,
    current_value text,
    proposed_value text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reason text,
    requested_by uuid NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_change_requests_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text])))
);


--
-- Name: configuration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.configuration (
    key character varying(100) NOT NULL,
    value text NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: driver_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    doc_type character varying(50) NOT NULL,
    filename character varying(255) NOT NULL,
    mime_type character varying(100) NOT NULL,
    file_size integer NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    slot smallint DEFAULT 1 NOT NULL,
    CONSTRAINT driver_documents_doc_type_check CHECK (((doc_type)::text = ANY (ARRAY[('license'::character varying)::text, ('insurance'::character varying)::text, ('registration'::character varying)::text]))),
    CONSTRAINT driver_documents_slot_check CHECK ((slot = ANY (ARRAY[1, 2])))
);


--
-- Name: driver_earnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_earnings (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    driver_id uuid NOT NULL,
    trip_id uuid NOT NULL,
    payment_id uuid,
    amount numeric(10,2) NOT NULL,
    currency character(3) DEFAULT 'CAD'::bpchar NOT NULL,
    status public.earning_status DEFAULT 'pending'::public.earning_status NOT NULL,
    paid_out_at timestamp with time zone,
    transfer_reference character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    vehicle_make character varying(100) NOT NULL,
    vehicle_model character varying(100) NOT NULL,
    vehicle_year smallint NOT NULL,
    license_plate character varying(20) NOT NULL,
    seat_count smallint DEFAULT 4 NOT NULL,
    home_address text,
    home_point public.geography(Point,4326) NOT NULL,
    service_radius_km numeric(5,2) DEFAULT 15.0 NOT NULL,
    average_rating numeric(3,2) DEFAULT 0.00,
    review_count integer DEFAULT 0,
    is_available boolean DEFAULT true NOT NULL,
    approval_status public.driver_approval_status DEFAULT 'incomplete'::public.driver_approval_status NOT NULL,
    approved_at timestamp with time zone,
    approved_by uuid,
    license_verified boolean DEFAULT false NOT NULL,
    insurance_verified boolean DEFAULT false NOT NULL,
    background_check_ok boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vehicle_color character varying(50),
    preferred_language character varying(10) DEFAULT 'fr'::character varying NOT NULL,
    approval_overridden boolean DEFAULT false NOT NULL,
    approval_overridden_by uuid,
    approval_overridden_at timestamp with time zone,
    CONSTRAINT driver_profiles_seat_count_check CHECK (((seat_count >= 1) AND (seat_count <= 15)))
);


--
-- Name: COLUMN driver_profiles.home_point; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.driver_profiles.home_point IS 'PostGIS point used to match drivers within their service_radius_km of a trip departure.';


--
-- Name: COLUMN driver_profiles.service_radius_km; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.driver_profiles.service_radius_km IS 'Default 15 km. Driver sees trips whose departure is within this radius.';


--
-- Name: COLUMN driver_profiles.preferred_language; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.driver_profiles.preferred_language IS 'Preferred language for email notifications: fr or en.';


--
-- Name: mobility_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobility_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notebook_id uuid NOT NULL,
    ticket_number bigint NOT NULL,
    status character varying(20) DEFAULT 'available'::character varying NOT NULL,
    trip_id uuid,
    used_by_driver_id uuid,
    reserved_at timestamp with time zone,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_out_at timestamp with time zone,
    CONSTRAINT mobility_tickets_status_check CHECK (((status)::text = ANY (ARRAY[('available'::character varying)::text, ('reserved'::character varying)::text, ('used'::character varying)::text, ('voided'::character varying)::text, ('paid_out'::character varying)::text])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    channel public.notification_channel NOT NULL,
    type character varying(80) NOT NULL,
    title character varying(200),
    message text NOT NULL,
    payload jsonb,
    is_read boolean DEFAULT false NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    trip_id uuid NOT NULL,
    provider character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    provider_reference character varying(255),
    amount numeric(10,2) NOT NULL,
    driver_share numeric(10,2) NOT NULL,
    platform_fee numeric(10,2) NOT NULL,
    currency character(3) DEFAULT 'CAD'::bpchar NOT NULL,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    failure_reason text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_method character varying(20) DEFAULT 'stripe'::character varying NOT NULL,
    stripe_setup_intent_id character varying(64),
    stripe_payment_method_id character varying(64),
    stripe_payment_intent_id character varying(64),
    payment_reference text,
    operator_note text,
    retry_count integer DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN payments.provider; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payments.provider IS 'Payment provider name. Update when integrating (Moneris recommended for Quebec).';


--
-- Name: COLUMN payments.driver_share; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payments.driver_share IS '75% of total amount.';


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    trip_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    reviewed_user_id uuid NOT NULL,
    rating smallint NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    moderated_by uuid,
    moderated_at timestamp with time zone,
    reviewee_id uuid,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT reviews_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text])))
);


--
-- Name: ticket_notebooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_notebooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notebook_number integer NOT NULL,
    owner_type character varying(20) NOT NULL,
    owner_client_id uuid,
    org_name character varying(100),
    ticket_start bigint NOT NULL,
    facial_value numeric(10,2) NOT NULL,
    currency character varying(10) DEFAULT 'CAD'::character varying NOT NULL,
    created_by uuid NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notebook_key character varying(6) NOT NULL,
    paid boolean DEFAULT false NOT NULL,
    paid_at date,
    paid_by text,
    CONSTRAINT notebook_owner_valid CHECK (((((owner_type)::text = 'client'::text) AND (owner_client_id IS NOT NULL) AND (org_name IS NULL)) OR (((owner_type)::text = 'organization'::text) AND (owner_client_id IS NULL)))),
    CONSTRAINT ticket_notebooks_owner_type_check CHECK (((owner_type)::text = ANY (ARRAY[('client'::character varying)::text, ('organization'::character varying)::text])))
);


--
-- Name: ticket_notebooks_notebook_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ticket_notebooks_notebook_number_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ticket_notebooks_notebook_number_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ticket_notebooks_notebook_number_seq OWNED BY public.ticket_notebooks.notebook_number;


--
-- Name: trip_driver_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_driver_actions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    trip_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    action character varying(10) NOT NULL,
    is_preferred boolean DEFAULT false NOT NULL,
    actioned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trip_driver_actions_action_check CHECK (((action)::text = ANY (ARRAY[('accepted'::character varying)::text, ('declined'::character varying)::text])))
);


--
-- Name: TABLE trip_driver_actions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.trip_driver_actions IS 'Logs every manual driver action (accept/decline) on a pending trip. is_preferred = true when the driver was the client''s preferred choice. One row per (trip, driver) — upsert on conflict.';


--
-- Name: COLUMN trip_driver_actions.action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trip_driver_actions.action IS '''accepted'' or ''declined'' — set by the driver clicking a button in AvailableTrips.';


--
-- Name: COLUMN trip_driver_actions.is_preferred; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trip_driver_actions.is_preferred IS 'True when driver was trip.preferred_driver_id at the time of the action.';


--
-- Name: trip_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_messages (
    id integer NOT NULL,
    trip_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT trip_messages_body_length CHECK (((char_length(body) >= 1) AND (char_length(body) <= 500)))
);


--
-- Name: trip_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trip_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trip_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trip_messages_id_seq OWNED BY public.trip_messages.id;


--
-- Name: trips_trip_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trips_trip_number_seq
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    client_id uuid NOT NULL,
    driver_id uuid,
    created_by_admin uuid,
    pickup_address text NOT NULL,
    pickup_point public.geography(Point,4326) NOT NULL,
    dropoff_address text NOT NULL,
    dropoff_point public.geography(Point,4326) NOT NULL,
    departure_at timestamp with time zone NOT NULL,
    return_at timestamp with time zone,
    passenger_count smallint DEFAULT 1 NOT NULL,
    distance_km numeric(8,2),
    duration_minutes integer,
    estimated_cost numeric(10,2),
    final_cost numeric(10,2),
    status public.trip_status DEFAULT 'pending'::public.trip_status NOT NULL,
    cancellation_reason text,
    cancelled_by uuid,
    assigned_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    preferred_driver_id uuid,
    client_notes text,
    completion_source public.completion_source,
    trip_number integer DEFAULT nextval('public.trips_trip_number_seq'::regclass) NOT NULL,
    preferred_driver_notified_at timestamp with time zone,
    preferred_driver_declined boolean DEFAULT false,
    broadcast_at timestamp with time zone,
    broadcast_reminder_sent boolean DEFAULT false,
    last_broadcast_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    CONSTRAINT trips_passenger_count_check CHECK ((passenger_count >= 1))
);


--
-- Name: COLUMN trips.created_by_admin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trips.created_by_admin IS 'Set when an operator creates the trip on behalf of a client (phone intake flow).';


--
-- Name: COLUMN trips.pickup_point; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trips.pickup_point IS 'Used to find available drivers within their service_radius_km.';


--
-- Name: COLUMN trips.preferred_driver_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trips.preferred_driver_id IS 'Driver preferred by the client at booking time. Trip remains visible to all drivers if this driver does not accept.';


--
-- Name: COLUMN trips.client_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trips.client_notes IS 'Optional note from the client to the driver (e.g. mobility needs, meeting point details).';


--
-- Name: users_member_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_member_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    phone character varying(20),
    role public.user_role DEFAULT 'client'::public.user_role NOT NULL,
    status public.user_status DEFAULT 'pending'::public.user_status NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    phone_verified boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_protected boolean DEFAULT false NOT NULL,
    stripe_customer_id character varying(64),
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    account_locked_at timestamp with time zone,
    member_number integer DEFAULT nextval('public.users_member_number_seq'::regclass) NOT NULL
);


--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.users IS 'Central identity for all users: clients, drivers, operators, admins.';


--
-- Name: COLUMN users.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.role IS 'client=vulnerable person, driver=volunteer, operator=phone admin, superadmin=full access';


--
-- Name: COLUMN users.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.status IS 'pending until email verified (client) or manually approved (driver)';


--
-- Name: verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    token character varying(128) NOT NULL,
    type public.token_type DEFAULT 'email_verification'::public.token_type NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    trip_id uuid,
    action character varying(20)
);


--
-- Name: TABLE verification_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.verification_tokens IS 'Single-use tokens for email verification and password reset. Expires in 24h.';


--
-- Name: ticket_notebooks notebook_number; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notebooks ALTER COLUMN notebook_number SET DEFAULT nextval('public.ticket_notebooks_notebook_number_seq'::regclass);


--
-- Name: trip_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_messages ALTER COLUMN id SET DEFAULT nextval('public.trip_messages_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: client_profiles client_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_pkey PRIMARY KEY (id);


--
-- Name: client_profiles client_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_user_id_key UNIQUE (user_id);


--
-- Name: config_change_requests config_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_change_requests
    ADD CONSTRAINT config_change_requests_pkey PRIMARY KEY (id);


--
-- Name: configuration configuration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuration
    ADD CONSTRAINT configuration_pkey PRIMARY KEY (key);


--
-- Name: driver_documents driver_documents_driver_doc_slot; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_documents
    ADD CONSTRAINT driver_documents_driver_doc_slot UNIQUE (driver_id, doc_type, slot);


--
-- Name: driver_documents driver_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_documents
    ADD CONSTRAINT driver_documents_pkey PRIMARY KEY (id);


--
-- Name: driver_earnings driver_earnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_pkey PRIMARY KEY (id);


--
-- Name: driver_earnings driver_earnings_trip_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_trip_id_key UNIQUE (trip_id);


--
-- Name: driver_profiles driver_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_pkey PRIMARY KEY (id);


--
-- Name: driver_profiles driver_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_user_id_key UNIQUE (user_id);


--
-- Name: mobility_tickets mobility_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobility_tickets
    ADD CONSTRAINT mobility_tickets_pkey PRIMARY KEY (id);


--
-- Name: mobility_tickets mobility_tickets_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobility_tickets
    ADD CONSTRAINT mobility_tickets_ticket_number_key UNIQUE (ticket_number);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payments payments_trip_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_trip_id_key UNIQUE (trip_id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_unique_reviewer_trip; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_unique_reviewer_trip UNIQUE (trip_id, reviewer_id);


--
-- Name: ticket_notebooks ticket_notebooks_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notebooks
    ADD CONSTRAINT ticket_notebooks_key_unique UNIQUE (notebook_key);


--
-- Name: ticket_notebooks ticket_notebooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notebooks
    ADD CONSTRAINT ticket_notebooks_pkey PRIMARY KEY (id);


--
-- Name: ticket_notebooks ticket_notebooks_ticket_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notebooks
    ADD CONSTRAINT ticket_notebooks_ticket_start_key UNIQUE (ticket_start);


--
-- Name: trip_driver_actions trip_driver_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_driver_actions
    ADD CONSTRAINT trip_driver_actions_pkey PRIMARY KEY (trip_id, driver_id);


--
-- Name: trip_messages trip_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_messages
    ADD CONSTRAINT trip_messages_pkey PRIMARY KEY (id);


--
-- Name: trips trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);


--
-- Name: trips trips_trip_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_trip_number_unique UNIQUE (trip_number);


--
-- Name: reviews uq_reviews_trip_reviewer; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT uq_reviews_trip_reviewer UNIQUE (trip_id, reviewer_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_member_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_member_number_key UNIQUE (member_number);


--
-- Name: users users_phone_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_unique UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verification_tokens verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: verification_tokens verification_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_token_key UNIQUE (token);


--
-- Name: config_change_requests_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX config_change_requests_one_pending ON public.config_change_requests USING btree (config_key) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_audit_logs_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_actor ON public.audit_logs USING btree (actor_id);


--
-- Name: idx_audit_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_created ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_entity ON public.audit_logs USING btree (entity_type, entity_id);


--
-- Name: idx_client_profiles_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_profiles_user ON public.client_profiles USING btree (user_id);


--
-- Name: idx_driver_profiles_avail; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_profiles_avail ON public.driver_profiles USING btree (is_available, approval_status);


--
-- Name: idx_driver_profiles_home; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_profiles_home ON public.driver_profiles USING gist (home_point);


--
-- Name: idx_driver_profiles_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_profiles_user ON public.driver_profiles USING btree (user_id);


--
-- Name: idx_earnings_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earnings_driver ON public.driver_earnings USING btree (driver_id);


--
-- Name: idx_earnings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_earnings_status ON public.driver_earnings USING btree (status);


--
-- Name: idx_mobility_tickets_notebook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobility_tickets_notebook ON public.mobility_tickets USING btree (notebook_id);


--
-- Name: idx_mobility_tickets_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobility_tickets_number ON public.mobility_tickets USING btree (ticket_number);


--
-- Name: idx_mobility_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobility_tickets_status ON public.mobility_tickets USING btree (status);


--
-- Name: idx_mobility_tickets_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mobility_tickets_trip ON public.mobility_tickets USING btree (trip_id);


--
-- Name: idx_notebooks_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notebooks_client ON public.ticket_notebooks USING btree (owner_client_id);


--
-- Name: idx_notifications_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_read ON public.notifications USING btree (user_id, is_read);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);


--
-- Name: idx_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_status ON public.payments USING btree (status);


--
-- Name: idx_payments_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_trip ON public.payments USING btree (trip_id);


--
-- Name: idx_reviews_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_pending ON public.reviews USING btree (status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_reviews_reviewed_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewed_user ON public.reviews USING btree (reviewed_user_id);


--
-- Name: idx_reviews_reviewee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewee ON public.reviews USING btree (reviewee_id);


--
-- Name: idx_reviews_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_reviewer ON public.reviews USING btree (reviewer_id);


--
-- Name: idx_reviews_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_trip ON public.reviews USING btree (trip_id);


--
-- Name: idx_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tokens_token ON public.verification_tokens USING btree (token);


--
-- Name: idx_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tokens_user ON public.verification_tokens USING btree (user_id, type);


--
-- Name: idx_trip_driver_actions_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_driver_actions_driver ON public.trip_driver_actions USING btree (driver_id);


--
-- Name: idx_trip_driver_actions_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_driver_actions_trip ON public.trip_driver_actions USING btree (trip_id);


--
-- Name: idx_trip_driver_actions_trip_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_driver_actions_trip_action ON public.trip_driver_actions USING btree (trip_id, action);


--
-- Name: idx_trips_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_client ON public.trips USING btree (client_id);


--
-- Name: idx_trips_departure; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_departure ON public.trips USING btree (departure_at);


--
-- Name: idx_trips_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_driver ON public.trips USING btree (driver_id);


--
-- Name: idx_trips_pickup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_pickup ON public.trips USING gist (pickup_point);


--
-- Name: idx_trips_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_status ON public.trips USING btree (status);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_role ON public.users USING btree (role);


--
-- Name: idx_users_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_status ON public.users USING btree (status);


--
-- Name: trip_messages_sender_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_messages_sender_idx ON public.trip_messages USING btree (sender_id);


--
-- Name: trip_messages_trip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_messages_trip_idx ON public.trip_messages USING btree (trip_id, created_at DESC);


--
-- Name: reviews after_review_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER after_review_insert AFTER INSERT ON public.reviews FOR EACH ROW EXECUTE FUNCTION public.update_driver_rating();


--
-- Name: client_profiles set_updated_at_client_profiles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_client_profiles BEFORE UPDATE ON public.client_profiles FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();


--
-- Name: driver_earnings set_updated_at_driver_earnings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_driver_earnings BEFORE UPDATE ON public.driver_earnings FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();


--
-- Name: driver_profiles set_updated_at_driver_profiles; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_driver_profiles BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();


--
-- Name: payments set_updated_at_payments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_payments BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();


--
-- Name: trips set_updated_at_trips; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_trips BEFORE UPDATE ON public.trips FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();


--
-- Name: users set_updated_at_users; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_users BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();


--
-- Name: audit_logs audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: client_profiles client_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_profiles
    ADD CONSTRAINT client_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: config_change_requests config_change_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_change_requests
    ADD CONSTRAINT config_change_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: config_change_requests config_change_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_change_requests
    ADD CONSTRAINT config_change_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: configuration configuration_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuration
    ADD CONSTRAINT configuration_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: driver_documents driver_documents_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_documents
    ADD CONSTRAINT driver_documents_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: driver_earnings driver_earnings_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id);


--
-- Name: driver_earnings driver_earnings_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);


--
-- Name: driver_earnings driver_earnings_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_earnings
    ADD CONSTRAINT driver_earnings_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: driver_profiles driver_profiles_approval_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_approval_overridden_by_fkey FOREIGN KEY (approval_overridden_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: driver_profiles driver_profiles_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: driver_profiles driver_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: mobility_tickets mobility_tickets_notebook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobility_tickets
    ADD CONSTRAINT mobility_tickets_notebook_id_fkey FOREIGN KEY (notebook_id) REFERENCES public.ticket_notebooks(id) ON DELETE CASCADE;


--
-- Name: mobility_tickets mobility_tickets_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobility_tickets
    ADD CONSTRAINT mobility_tickets_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE SET NULL;


--
-- Name: mobility_tickets mobility_tickets_used_by_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobility_tickets
    ADD CONSTRAINT mobility_tickets_used_by_driver_id_fkey FOREIGN KEY (used_by_driver_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments payments_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: reviews reviews_moderated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id);


--
-- Name: reviews reviews_reviewed_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_reviewed_user_id_fkey FOREIGN KEY (reviewed_user_id) REFERENCES public.users(id);


--
-- Name: reviews reviews_reviewee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_reviewee_id_fkey FOREIGN KEY (reviewee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: reviews reviews_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: ticket_notebooks ticket_notebooks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notebooks
    ADD CONSTRAINT ticket_notebooks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: ticket_notebooks ticket_notebooks_owner_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notebooks
    ADD CONSTRAINT ticket_notebooks_owner_client_id_fkey FOREIGN KEY (owner_client_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: trip_driver_actions trip_driver_actions_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_driver_actions
    ADD CONSTRAINT trip_driver_actions_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: trip_driver_actions trip_driver_actions_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_driver_actions
    ADD CONSTRAINT trip_driver_actions_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trip_messages trip_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_messages
    ADD CONSTRAINT trip_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


--
-- Name: trip_messages trip_messages_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_messages
    ADD CONSTRAINT trip_messages_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trips trips_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id);


--
-- Name: trips trips_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.users(id);


--
-- Name: trips trips_created_by_admin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_created_by_admin_fkey FOREIGN KEY (created_by_admin) REFERENCES public.users(id);


--
-- Name: trips trips_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id);


--
-- Name: trips trips_preferred_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_preferred_driver_id_fkey FOREIGN KEY (preferred_driver_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: verification_tokens verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_tokens
    ADD CONSTRAINT verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict sKfXj3FVLdbxbzBg9Md400LeLNPu8eBdAWvsPLvLt7tEWIXbOsjhQod8CdXdsCC

