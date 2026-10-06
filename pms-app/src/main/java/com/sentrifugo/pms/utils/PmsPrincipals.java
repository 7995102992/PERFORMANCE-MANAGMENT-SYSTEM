package com.sentrifugo.pms.utils;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.security.context.PmsUserPrincipal;

/** Reads the organisation scope off the authenticated principal; it is never taken from a request. */
public final class PmsPrincipals {

    private PmsPrincipals() {
    }

    /**
     * IAM ids are MongoDB ObjectIds (24-character hex strings), so the organisation id is kept as a string.
     * A session without an organisation id cannot be scoped and is refused rather than guessed at.
     */
    public static String organisationId(PmsUserPrincipal user) {
        String raw = user == null ? null : user.organisationId();
        if (raw == null || raw.isBlank()) {
            throw DomainException.forbidden("The session has no organisation.", "PMS_INVALID_ORGANISATION");
        }
        return raw;
    }
}
