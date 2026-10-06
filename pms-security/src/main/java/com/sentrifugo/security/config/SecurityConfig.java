package com.sentrifugo.security.config;

import com.sentrifugo.security.access.SecurityErrorHandler;
import com.sentrifugo.security.filter.BearerTokenFilter;
import com.sentrifugo.security.service.SessionService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.annotation.AnnotationTemplateExpressionDefaults;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   SessionService sessionService,
                                                   SecurityErrorHandler errorHandler)
            throws Exception {

        http
                // Must come before authorization so browser preflight (OPTIONS) requests get CORS headers
                // instead of a 401 from the authenticated-only rule below.
                .cors(Customizer.withDefaults())

                .csrf(csrf -> csrf.disable())

                .formLogin(form -> form.disable())

                .httpBasic(basic -> basic.disable())

                .logout(logout -> logout.disable())

                .sessionManagement(session ->
                        session.sessionCreationPolicy(
                                SessionCreationPolicy.STATELESS
                        )
                )

                .authorizeHttpRequests(auth -> auth

//                        .requestMatchers("/api/home/health")
//                        .permitAll()
                                .requestMatchers(
                                        "/swagger-ui.html",
                                        "/swagger-ui/**",
                                        "/v3/api-docs/**"
                                )
                                .permitAll()
                        .requestMatchers("/api/home/valkey-test")
                        .permitAll()

                        .anyRequest()
                        .authenticated()
                )

                .exceptionHandling(errors -> errors
                        .authenticationEntryPoint(errorHandler)
                        .accessDeniedHandler(errorHandler)
                )

                // Built here rather than as a @Component so Boot does not also
                // register it as a plain servlet filter outside the chain.
                .addFilterBefore(
                        new BearerTokenFilter(sessionService),
                        UsernamePasswordAuthenticationFilter.class
                );

        return http.build();
    }

    /**
     * Allows the browser frontend to call the API cross-origin. Origins come from {@code pms.cors.allowed-origins}
     * (comma-separated); the default is the Vite dev server.
     */
    @Bean
    CorsConfigurationSource corsConfigurationSource(
            @Value("${pms.cors.allowed-origins:http://localhost:5173}") List<String> allowedOrigins) {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(allowedOrigins);
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        config.setExposedHeaders(List.of("Content-Disposition"));
        config.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }

    /** Lets {@code @RequirePermission} substitute its attributes into its @PreAuthorize expression. */
    @Bean
    static AnnotationTemplateExpressionDefaults templateExpressionDefaults() {
        return new AnnotationTemplateExpressionDefaults();
    }
}
