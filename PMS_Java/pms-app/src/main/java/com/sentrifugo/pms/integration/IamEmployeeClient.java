package com.sentrifugo.pms.integration;

import com.sentrifugo.common.exception.DomainException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.List;

/**
 * Reads employees from IAM on the caller's behalf. IAM checks the forwarded token, so
 * the caller only ever sees the employees IAM lets them see.
 */
@Slf4j
@Component
public class IamEmployeeClient {

    private static final int PAGE_LIMIT = 1000;

    private final RestClient restClient;

    @Autowired
    public IamEmployeeClient(@Value("${pms.iam.base-url}") String baseUrl) {
        this(baseUrl, RestClient.builder());
    }

    /** Package-private so tests can bind a mock server to the builder. */
    IamEmployeeClient(String baseUrl, RestClient.Builder builder) {
        this.restClient = builder.baseUrl(baseUrl).build();
    }

    /** Direct reports of {@code managerUserId} (IAM's {@code l1_manager_id}). */
    public List<IamEmployee> directReports(String accessToken, String managerUserId) {
        try {
            IamEmployee[] rows = restClient.get()
                    .uri(uri -> uri.path("/employees/")
                            .queryParam("l1_manager_id", managerUserId)
                            .queryParam("limit", PAGE_LIMIT)
                            .build())
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + accessToken)
                    .retrieve()
                    .body(IamEmployee[].class);
            return rows == null ? List.of() : List.of(rows);
        } catch (HttpClientErrorException.Unauthorized e) {
            throw new DomainException("Your session is no longer valid. Sign in again.", "UNAUTHORIZED",
                    HttpStatus.UNAUTHORIZED);
        } catch (RestClientException e) {
            log.warn("IAM employee lookup failed: {}", e.getMessage());
            throw new DomainException("The employee directory is unavailable. Try again shortly.",
                    "IAM_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE);
        }
    }
}
