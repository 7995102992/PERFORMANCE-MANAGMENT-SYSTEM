package com.sentrifugo.pms.integration;

import com.sentrifugo.common.exception.DomainException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withServerError;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

class IamEmployeeClientTest {

    private static final String DIRECT_REPORTS = "http://iam.test/employees/?l1_manager_id=m-1&limit=1000";

    @Test
    void directReportsAreRequestedWithTheCallersTokenAndMapped() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        IamEmployeeClient client = new IamEmployeeClient("http://iam.test", builder);

        server.expect(requestTo(DIRECT_REPORTS))
                .andExpect(method(HttpMethod.GET))
                .andExpect(header("Authorization", "Bearer tok"))
                .andRespond(withSuccess("""
                        [{"userId":"u-1","empCode":"SCIL-3","firstName":"Suresh Babu","lastName":"N.",
                          "workEmail":"suresh@example.com","designationId":"d-1","unknownField":1}]
                        """, MediaType.APPLICATION_JSON));

        List<IamEmployee> rows = client.directReports("tok", "m-1");

        server.verify();
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).userId()).isEqualTo("u-1");
        assertThat(rows.get(0).empCode()).isEqualTo("SCIL-3");
        assertThat(rows.get(0).firstName()).isEqualTo("Suresh Babu");
        assertThat(rows.get(0).workEmail()).isEqualTo("suresh@example.com");
    }

    @Test
    void iamRejectingTheTokenIsReportedAsUnauthorized() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        IamEmployeeClient client = new IamEmployeeClient("http://iam.test", builder);

        server.expect(requestTo(DIRECT_REPORTS)).andRespond(withStatus(HttpStatus.UNAUTHORIZED));

        assertThatThrownBy(() -> client.directReports("expired", "m-1"))
                .isInstanceOfSatisfying(DomainException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("UNAUTHORIZED");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED);
                });
    }

    @Test
    void iamFailingIsReportedAsServiceUnavailable() {
        RestClient.Builder builder = RestClient.builder();
        MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
        IamEmployeeClient client = new IamEmployeeClient("http://iam.test", builder);

        server.expect(requestTo(DIRECT_REPORTS)).andRespond(withServerError());

        assertThatThrownBy(() -> client.directReports("tok", "m-1"))
                .isInstanceOfSatisfying(DomainException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("IAM_UNAVAILABLE");
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                });
    }
}
