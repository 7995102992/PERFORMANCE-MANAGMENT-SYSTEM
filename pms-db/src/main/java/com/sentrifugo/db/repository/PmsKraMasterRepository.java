package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsKraMasterEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsKraMasterRepository extends JpaRepository<PmsKraMasterEntity, UUID> {

    /** Organisation-scoped lookup: the way to load a row without crossing tenants. */
    Optional<PmsKraMasterEntity> findByIdAndOrganisationId(UUID id, String organisationId);

    /** Rows not removed by the Delete action (is_active = true), oldest first. */
    List<PmsKraMasterEntity> findByOrganisationIdAndIsActiveTrueOrderByCreatedDateAsc(String organisationId);

    boolean existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrue(String organisationId, String name);

    boolean existsByOrganisationIdAndNameIgnoreCaseAndIsActiveTrueAndIdNot(String organisationId, String name, UUID id);
}
