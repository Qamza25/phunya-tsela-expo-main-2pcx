/**
 * auth.js — Phunya Tsela  (v8 — Supabase load-safe)
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles auth, profile, history (localStorage), and result syncing to Supabase.
 * IMPORTANT: This file must be loaded AFTER the Supabase CDN script tag.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── CONFIG ────────────────────────────────────────────────────────────────────
var SUPABASE_URL = 'https://lfnnglzjqszdjomjmpkw.supabase.co';


var SUPABASE_KEY = 'sb_publishable_zfTqPTfONlZ04Of9ERrKww_2ICi7FCU';
// ─────────────────────────────────────────────────────────────────────────────

var _sbClient = null;

/**
 * Returns the Supabase client, throwing a clear error if the CDN
 * hasn't loaded yet (so the developer knows exactly what's wrong).
 */
function _sb() {
  if (_sbClient) return _sbClient;

  // Check every possible way the Supabase CDN exposes itself
  var sbLib = (typeof supabase !== 'undefined' && supabase)
           || (typeof window !== 'undefined' && window.supabase)
           || (typeof globalThis !== 'undefined' && globalThis.supabase);

  if (!sbLib || typeof sbLib.createClient !== 'function') {
    throw new Error(
      'Supabase CDN not loaded. Add this BEFORE auth.js on every page:\n' +
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"><\/script>'
    );
  }

  _sbClient = sbLib.createClient(SUPABASE_URL, SUPABASE_KEY);
  return _sbClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone → email helper
// ─────────────────────────────────────────────────────────────────────────────
function _phoneToEmail(raw) {
  var digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+27')) {
    digits = '0' + digits.slice(3);
  }
  return digits + '@phunya.local';
}

function _isPhone(identifier) {
  return /^(\+27|0)\d[\d\s\-]{6,}$/.test(identifier.trim());
}

function _buildEmail(identifier) {
  var clean = identifier.trim();
  return _isPhone(clean) ? _phoneToEmail(clean) : clean;
}

// ─────────────────────────────────────────────────────────────────────────────
// localStorage history helpers
// ─────────────────────────────────────────────────────────────────────────────
var HISTORY_PREFIX = 'phunya_history_';
function _historyKey(uid) { return HISTORY_PREFIX + uid; }

// ─────────────────────────────────────────────────────────────────────────────
// Auth object
// ─────────────────────────────────────────────────────────────────────────────
var Auth = {

  // ── Auth ──────────────────────────────────────────────────────────────────

  async register({ identifier, firstName, lastName, password, grade, school, recoveryEmail }) {
    try {
      var email = _buildEmail(identifier);
      var phone = _isPhone(identifier.trim()) ? identifier.trim() : null;

      var { data, error } = await _sb().auth.signUp({
        email,
        password,
        options: {
          data: {
            first_name:     firstName,
            last_name:      lastName,
            grade:          grade         || '',
            school:         school        || '',
            phone:          phone         || '',
            recovery_email: recoveryEmail || '',
          }
        }
      });

      if (error) return { ok: false, error: error.message };
      if (!data.user) return { ok: false, error: 'Registration failed. Please try again.' };

      var { error: profileError } = await _sb().from('profiles').upsert({
        id:             data.user.id,
        email:          email,
        first_name:     firstName,
        last_name:      lastName,
        grade:          grade         || '',
        school:         school        || '',
        phone:          phone         || '',
        recovery_email: recoveryEmail || '',
        role:           'learner',
      }, { onConflict: 'id' });

      if (profileError) {
        console.warn('Profile save error:', profileError.message);
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async login({ identifier, password }) {
    try {
      var email = _buildEmail(identifier);
      var { data, error } = await _sb().auth.signInWithPassword({ email, password });
      if (error) return { ok: false, error: 'Incorrect details. Please check and try again.' };
      if (!data.user) return { ok: false, error: 'Login failed.' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async getSession() {
    try {
      var { data } = await _sb().auth.getSession();
      return data.session || null;
    } catch (e) {
      console.error('getSession error:', e.message);
      return null;
    }
  },

  async requireAuth() {
    try {
      var session = await this.getSession();
      if (!session || !session.user) {
        window.location.href = 'login.html';
        return null;
      }

      var uid  = session.user.id;
      var meta = session.user.user_metadata || {};

      var profile = null;
      try {
        var { data } = await _sb().from('profiles').select('*').eq('id', uid).single();
        profile = data;
      } catch (e) { /* fallback to meta */ }

      return {
        id:        uid,
        email:     session.user.email,
        firstName: (profile && profile.first_name) || meta.first_name || '',
        lastName:  (profile && profile.last_name)  || meta.last_name  || '',
        grade:     (profile && profile.grade)       || meta.grade      || '',
        school:    (profile && profile.school)      || meta.school     || '',
        phone:     (profile && profile.phone)       || meta.phone      || '',
        role:      (profile && profile.role)        || 'learner',
      };
    } catch (e) {
      console.error('requireAuth error:', e.message);
      window.location.href = 'login.html';
      return null;
    }
  },

  async logout() {
    try { await _sb().auth.signOut(); } catch (e) { /* ignore */ }
  },
  // ── Forgot Password ───────────────────────────────────────────────────────

  /**
   * Decides which reset path to use for a given identifier.
   * Returns one of:
   *   { ok: true, mode: 'email' }        — reset email was sent
   *   { ok: true, mode: 'otp', phone }   — SMS OTP was sent, caller should show OTP step
   *   { ok: false, error }
   */
  async forgotPassword(identifier) {
    try {
      var clean = (identifier || '').trim();
      if (!clean) return { ok: false, error: 'Please enter your email address or cell number.' };

      if (_isPhone(clean)) {
        // If they have a recovery email on file, prefer the normal email-link flow.
        var recoveryEmail = null;
        try {
          var { data: profileData } = await _sb()
            .from('profiles')
            .select('recovery_email')
            .eq('phone', clean)
            .single();
          if (profileData && profileData.recovery_email) {
            recoveryEmail = profileData.recovery_email;
          }
        } catch (e) { /* no profile / no recovery email — fall back to OTP */ }

        if (recoveryEmail) {
          var { error: linkError } = await _sb().auth.resetPasswordForEmail(recoveryEmail, {
            redirectTo: window.location.origin + '/reset-password.html',
          });
          if (linkError) return { ok: false, error: linkError.message };
          return { ok: true, mode: 'email' };
        }

        // No recovery email on file — use SMS OTP instead.
        var otpResult = await this.sendOtp(clean);
        if (!otpResult.ok) return { ok: false, error: otpResult.error || 'Could not send code. Please try again.' };
        return { ok: true, mode: 'otp', phone: clean };
      }

      // Identifier is an email address — normal Supabase reset-link flow.
      var { error } = await _sb().auth.resetPasswordForEmail(clean, {
        redirectTo: window.location.origin + '/reset-password.html',
      });
      if (error) return { ok: false, error: error.message };
      return { ok: true, mode: 'email' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /**
   * Sends a 6-digit SMS OTP for password reset via the "send-otp" Edge Function.
   */
  async sendOtp(phone) {
    try {
      var resp = await fetch(SUPABASE_URL + '/functions/v1/send-otp', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization':  'Bearer ' + SUPABASE_KEY,
        },
        body: JSON.stringify({ phone: phone }),
      });
      var json = await resp.json();
      if (!resp.ok) return { ok: false, error: json.error || 'Could not send code.' };
      return json;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  /**
   * Verifies the SMS OTP and sets the new password via the
   * "verify-otp-and-reset" Edge Function.
   */
  async verifyOtpAndReset(phone, otp, newPassword) {
    try {
      if (!newPassword || newPassword.length < 6) {
        return { ok: false, error: 'Password must be at least 6 characters.' };
      }
      var resp = await fetch(SUPABASE_URL + '/functions/v1/verify-otp-and-reset', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization':  'Bearer ' + SUPABASE_KEY,
        },
        body: JSON.stringify({ phone: phone, otp: otp, newPassword: newPassword }),
      });
      var json = await resp.json();
      if (!resp.ok) return { ok: false, error: json.error || 'Invalid or expired code.' };
      return json;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },


  // ── Update Password (used on reset-password page after email link) ────────

  async updatePassword(newPassword) {
    try {
      if (!newPassword || newPassword.length < 6) {
        return { ok: false, error: 'Password must be at least 6 characters.' };
      }
      var { error } = await _sb().auth.updateUser({ password: newPassword });
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // ── History (localStorage) ────────────────────────────────────────────────

  loadHistory(uid) {
    try {
      var raw = localStorage.getItem(_historyKey(uid));
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  },

  _saveHistory(uid, history) {
    try {
      localStorage.setItem(_historyKey(uid), JSON.stringify(history));
    } catch (e) { /* storage full */ }
  },

  clearHistory(uid) {
    localStorage.removeItem(_historyKey(uid));
  },

  // ── Save APS Result ───────────────────────────────────────────────────────

  async saveAPSResult(uid, { apsScore, subjects, mathType, summary }) {
    var history = this.loadHistory(uid);
    history.unshift({
      type:    'aps',
      savedAt: new Date().toISOString(),
      summary: summary || ('APS Score: ' + apsScore),
      data: {
        apsScore,
        total:    apsScore,
        subjects: subjects || [],
        mathType: mathType || 'mathematics',
      },
    });
    this._saveHistory(uid, history);

    try {
      var sb = _sb();
      var { data: sessionData } = await sb.auth.getSession();
      if (!sessionData || !sessionData.session) {
        console.warn('No active Supabase session — APS result saved to localStorage only');
        return;
      }

      var { error: delError } = await sb.from('aps_results').delete().eq('user_id', uid);
      if (delError) console.warn('APS delete before insert failed:', delError.message);

      var { error: insError } = await sb.from('aps_results').insert({
        user_id:   uid,
        aps_score: apsScore,
        subjects:  subjects || [],
        math_type: mathType || 'mathematics',
      });

      if (insError) {
        console.error('Supabase APS save error:', insError.message);
      } else {
        console.log('APS result saved to Supabase — score:', apsScore);
      }
    } catch (e) {
      console.error('Supabase APS save exception:', e.message);
    }
  },

  // ── Save Psychometric Result ──────────────────────────────────────────────

  async savePsychResult(uid, { scores, topTypes, primaryType, summary }) {
    var history = this.loadHistory(uid);
    history.unshift({
      type:    'psych',
      savedAt: new Date().toISOString(),
      summary: summary || ('Primary type: ' + (topTypes && topTypes[0])),
      data: {
        scores:      scores   || {},
        topTypes:    topTypes || [],
        primaryType: primaryType || (topTypes && topTypes[0]) || '',
      },
    });
    this._saveHistory(uid, history);

    try {
      var sb = _sb();
      var { data: sessionData } = await sb.auth.getSession();
      if (!sessionData || !sessionData.session) {
        console.warn('No active Supabase session — psych result saved to localStorage only');
        return;
      }

      var { error: delError } = await sb.from('psych_results').delete().eq('user_id', uid);
      if (delError) console.warn('Psych delete before insert failed:', delError.message);

      var topTypesArray = Array.isArray(topTypes) ? topTypes : [];

      var { error: insError } = await sb.from('psych_results').insert({
        user_id:      uid,
        primary_type: primaryType || (topTypesArray[0]) || '',
        top_types:    topTypesArray,
        scores:       scores || {},
      });

      if (insError) {
        console.error('Supabase psych save error:', insError.message);
      } else {
        console.log('Psych result saved to Supabase — type:', primaryType || topTypesArray[0]);
      }
    } catch (e) {
      console.error('Supabase psych save exception:', e.message);
    }
  },
};