package com.sentrifugo.pms.configuration;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeIn;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeType;
import io.swagger.v3.oas.annotations.info.Info;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.security.SecurityScheme;

/**
 * Declares the bearer-token scheme Swagger UI's "Authorize" button uses.
 *
 * Paste the access token from {@code POST /auth/login} on IAM (no "Bearer "
 * prefix) and Swagger UI sends it as {@code Authorization: Bearer <token>} on
 * every request — the header {@link com.sentrifugo.security.filter.BearerTokenFilter}
 * reads. The scheme is marked global via the top-level {@code security}
 * requirement, so every endpoint shows the padlock by default; public routes
 * (health, swagger itself) stay reachable without one because
 * {@code SecurityConfig} permits them regardless of this header.
 */
@OpenAPIDefinition(
        info = @Info(title = "Sentrifugo PMS", version = "1.0.0"),
        security = @SecurityRequirement(name = "bearerAuth")
)
@SecurityScheme(
        name = "bearerAuth",
        type = SecuritySchemeType.HTTP,
        scheme = "bearer",
        bearerFormat = "JWT"
)
public class OpenApiConfig {
}
