package com.sentrifugo.security.config;

import com.sentrifugo.security.access.SecurityErrorHandler;
import com.sentrifugo.security.filter.BearerTokenFilter;
import com.sentrifugo.security.service.SessionService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.annotation.AnnotationTemplateExpressionDefaults;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http,
                                                   SessionService sessionService,
                                                   SecurityErrorHandler errorHandler)
            throws Exception {

        http
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

    /** Lets {@code @RequirePermission} substitute its attributes into its @PreAuthorize expression. */
    @Bean
    static AnnotationTemplateExpressionDefaults templateExpressionDefaults() {
        return new AnnotationTemplateExpressionDefaults();
    }
}
