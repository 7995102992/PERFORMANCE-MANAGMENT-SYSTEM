package com.sentrifugo.pms.configuration;

import com.sentrifugo.security.context.PmsUserPrincipal;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.domain.AuditorAware;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import java.util.Optional;

/**
 * Persistence wiring for pms-db. The application class lives in {@code com.sentrifugo.pms}, a sibling of
 * {@code com.sentrifugo.db}, so Spring Boot's default entity/repository scanning would miss pms-db.
 *
 * <p>Auditing ({@code created_by}/{@code modified_by}/dates on {@code BaseEntity}) is enabled here with an
 * auditor taken from the authenticated principal, never from request data. The audit columns hold the IAM user
 * id as a string; work with no authenticated caller leaves them null.
 */
@Configuration
@EntityScan(basePackages = "com.sentrifugo.db.entity")
@EnableJpaRepositories(basePackages = "com.sentrifugo.db.repository")
@EnableJpaAuditing(auditorAwareRef = "pmsAuditorAware")
public class JpaConfig {

    @Bean
    public AuditorAware<String> pmsAuditorAware() {
        return () -> {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() instanceof PmsUserPrincipal user) {
                return Optional.ofNullable(user.id());
            }
            return Optional.empty();
        };
    }
}
